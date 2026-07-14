// Package ops runs long-lived restic operations (backups now; prune/copy
// later) with per-repository serialization, persisted logs, and live events.
package ops

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/jonnyczi/restic-ui/internal/plan"
	"github.com/jonnyczi/restic-ui/internal/repo"
	"github.com/jonnyczi/restic-ui/internal/restic"
	"github.com/jonnyczi/restic-ui/internal/store"
)

// Operation is a persisted unit of work.
type Operation struct {
	ID        int64           `json:"id"`
	Type      string          `json:"type"`
	RepoID    *int64          `json:"repoId,omitempty"`
	RepoName  string          `json:"repoName,omitempty"`
	PlanID    *int64          `json:"planId,omitempty"`
	PlanName  string          `json:"planName,omitempty"`
	Status    string          `json:"status"` // queued|running|success|warning|error|canceled
	StartedAt *string         `json:"startedAt,omitempty"`
	EndedAt   *string         `json:"endedAt,omitempty"`
	ExitCode  *int            `json:"exitCode,omitempty"`
	Summary   json.RawMessage `json:"summary,omitempty"`
	CreatedAt string          `json:"createdAt"`
}

// ErrNotFound is returned for unknown operation ids.
var ErrNotFound = errors.New("operation not found")

// Notifier receives completed operations (wired to the notification service).
type Notifier interface {
	NotifyOp(op Operation)
}

// Runner executes operations, one at a time per repository.
type Runner struct {
	st       *store.Store
	repos    *repo.Service
	plans    *plan.Service
	restic   *restic.Runner
	hub      *Hub
	notifier Notifier

	mu        sync.Mutex
	repoLocks map[int64]*sync.Mutex
	cancels   map[int64]context.CancelFunc
}

// SetNotifier registers the completion notifier.
func (r *Runner) SetNotifier(n Notifier) { r.notifier = n }

// notifyDone fires the notifier for a terminal operation.
func (r *Runner) notifyDone(opID int64) {
	if r.notifier == nil {
		return
	}
	op, err := r.GetOperation(context.Background(), opID)
	if err != nil {
		return
	}
	go r.notifier.NotifyOp(*op)
}

// NewRunner constructs a Runner.
func NewRunner(st *store.Store, repos *repo.Service, plans *plan.Service, r *restic.Runner, hub *Hub) *Runner {
	return &Runner{
		st:        st,
		repos:     repos,
		plans:     plans,
		restic:    r,
		hub:       hub,
		repoLocks: make(map[int64]*sync.Mutex),
		cancels:   make(map[int64]context.CancelFunc),
	}
}

func (r *Runner) repoLock(repoID int64) *sync.Mutex {
	r.mu.Lock()
	defer r.mu.Unlock()
	if l, ok := r.repoLocks[repoID]; ok {
		return l
	}
	l := &sync.Mutex{}
	r.repoLocks[repoID] = l
	return l
}

func now() string { return time.Now().UTC().Format(time.RFC3339) }

// EnqueueBackup creates a queued backup operation for a plan and starts it in
// the background (serialized per repo). Returns the operation.
func (r *Runner) EnqueueBackup(ctx context.Context, planID int64) (*Operation, error) {
	p, err := r.plans.Get(ctx, planID)
	if err != nil {
		return nil, err
	}
	res, err := r.st.DB.ExecContext(ctx, `
		INSERT INTO operations (type, repo_id, plan_id, status, created_at)
		VALUES ('backup', ?, ?, 'queued', ?)`,
		p.RepoID, p.ID, now(),
	)
	if err != nil {
		return nil, err
	}
	opID, _ := res.LastInsertId()
	op, err := r.GetOperation(ctx, opID)
	if err != nil {
		return nil, err
	}
	r.hub.Publish(Event{Type: "op", Op: op})

	go func() {
		status := r.runBackup(opID, *p)
		r.notifyDone(opID)
		// Chain retention after a snapshot-producing run. Runs as its own
		// operation once the backup releases the repo lock.
		if (status == "success" || status == "warning") && !p.Retention.Empty() {
			if _, err := r.EnqueueForget(context.Background(), p.ID); err != nil {
				slog.Error("chain retention", "plan", p.ID, "err", err)
			}
		}
	}()
	return op, nil
}

// Cancel aborts a running operation.
func (r *Runner) Cancel(opID int64) bool {
	r.mu.Lock()
	cancel, ok := r.cancels[opID]
	r.mu.Unlock()
	if ok {
		cancel()
	}
	return ok
}

// opLogger persists and broadcasts log lines for one operation.
type opLogger struct {
	r    *Runner
	opID int64
	seq  int64
}

func (l *opLogger) log(level, msg string) {
	l.seq++
	line := LogLine{Seq: l.seq, TS: now(), Level: level, Message: msg}
	_, err := l.r.st.DB.Exec(`
		INSERT INTO operation_logs (operation_id, seq, ts, level, message) VALUES (?, ?, ?, ?, ?)`,
		l.opID, line.Seq, line.TS, line.Level, line.Message)
	if err != nil {
		slog.Error("persist op log", "op", l.opID, "err", err)
	}
	l.r.hub.Publish(Event{Type: "log", OpID: l.opID, Log: &line})
}

// setStatus updates operation state and broadcasts the change.
func (r *Runner) setStatus(opID int64, set string, args ...any) {
	_, err := r.st.DB.Exec(`UPDATE operations SET `+set+` WHERE id=?`, append(args, opID)...)
	if err != nil {
		slog.Error("update operation", "op", opID, "err", err)
	}
	if op, err := r.GetOperation(context.Background(), opID); err == nil {
		r.hub.Publish(Event{Type: "op", Op: op})
	}
}

// backupMessage covers the union of restic's --json backup stream lines.
type backupMessage struct {
	MessageType  string   `json:"message_type"` // status | summary | error | verbose_status
	PercentDone  float64  `json:"percent_done"`
	TotalFiles   int64    `json:"total_files"`
	FilesDone    int64    `json:"files_done"`
	TotalBytes   int64    `json:"total_bytes"`
	BytesDone    int64    `json:"bytes_done"`
	SecondsLeft  int64    `json:"seconds_remaining"`
	CurrentFiles []string `json:"current_files"`
	// summary
	SnapshotID          string  `json:"snapshot_id"`
	FilesNew            int64   `json:"files_new"`
	FilesChanged        int64   `json:"files_changed"`
	FilesUnmodified     int64   `json:"files_unmodified"`
	DataAdded           int64   `json:"data_added"`
	TotalFilesProcessed int64   `json:"total_files_processed"`
	TotalBytesProcessed int64   `json:"total_bytes_processed"`
	TotalDuration       float64 `json:"total_duration"`
	// error
	Error  json.RawMessage `json:"error"`
	During string          `json:"during"`
	Item   string          `json:"item"`
}

func (r *Runner) runBackup(opID int64, p plan.Plan) (finalStatus string) {
	lock := r.repoLock(p.RepoID)
	lock.Lock()
	defer lock.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	r.mu.Lock()
	r.cancels[opID] = cancel
	r.mu.Unlock()
	defer func() {
		cancel()
		r.mu.Lock()
		delete(r.cancels, opID)
		r.mu.Unlock()
	}()

	logger := &opLogger{r: r, opID: opID}
	r.setStatus(opID, `status='running', started_at=?`, now())
	logger.log("info", fmt.Sprintf("Starting backup for plan %q → repository %q", p.Name, p.RepoName))

	_, rc, err := r.repos.BuildRepoConfig(ctx, p.RepoID)
	if err != nil {
		logger.log("error", "Failed to prepare repository: "+err.Error())
		r.setStatus(opID, `status='error', ended_at=?`, now())
		return "error"
	}

	args := append([]string{"backup"}, p.Sources...)
	for _, e := range p.Excludes {
		args = append(args, "--exclude", e)
	}
	for _, t := range p.Tags {
		args = append(args, "--tag", t)
	}
	args = append(args, p.Options.Args()...)
	args = append(args, "--json")

	cmd := r.restic.Command(ctx, rc, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		logger.log("error", "Failed to start restic: "+err.Error())
		r.setStatus(opID, `status='error', ended_at=?`, now())
		return "error"
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		logger.log("error", "Failed to start restic: "+err.Error())
		r.setStatus(opID, `status='error', ended_at=?`, now())
		return "error"
	}

	var summaryJSON []byte
	lastProgress := time.Time{}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		var msg backupMessage
		if err := json.Unmarshal(line, &msg); err != nil {
			continue // non-JSON chatter
		}
		switch msg.MessageType {
		case "status":
			// Throttle broadcast to ~2/s; never persisted.
			if time.Since(lastProgress) >= 500*time.Millisecond {
				lastProgress = time.Now()
				cur := ""
				if len(msg.CurrentFiles) > 0 {
					cur = msg.CurrentFiles[0]
				}
				r.hub.Publish(Event{Type: "progress", OpID: opID, Progress: &Progress{
					PercentDone: msg.PercentDone,
					TotalFiles:  msg.TotalFiles,
					FilesDone:   msg.FilesDone,
					TotalBytes:  msg.TotalBytes,
					BytesDone:   msg.BytesDone,
					SecondsLeft: msg.SecondsLeft,
					CurrentFile: cur,
				}})
			}
		case "summary":
			summaryJSON = append([]byte(nil), line...)
			logger.log("info", fmt.Sprintf(
				"Snapshot %s saved: %d new, %d changed, %d unmodified files; %s added in %.1fs",
				short(msg.SnapshotID), msg.FilesNew, msg.FilesChanged, msg.FilesUnmodified,
				formatBytes(msg.DataAdded), msg.TotalDuration))
		case "error":
			logger.log("error", fmt.Sprintf("%s (during %s: %s)", errText(msg.Error), msg.During, msg.Item))
		}
	}
	if err := scanner.Err(); err != nil {
		logger.log("error", "Reading restic output: "+err.Error())
	}

	err = cmd.Wait()
	for _, l := range strings.Split(strings.TrimSpace(stderr.String()), "\n") {
		if l = strings.TrimSpace(l); l != "" {
			logger.log("warn", l)
		}
	}

	status, exitCode := "success", 0
	switch {
	case ctx.Err() != nil:
		status = "canceled"
		logger.log("warn", "Backup canceled.")
	case err != nil:
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = -1
		}
		if exitCode == 3 {
			// restic: some source files could not be read; snapshot was created.
			status = "warning"
			logger.log("warn", "Backup finished with warnings: some files could not be read.")
		} else {
			status = "error"
			logger.log("error", fmt.Sprintf("restic exited with code %d", exitCode))
		}
	default:
		logger.log("info", "Backup completed successfully.")
	}

	if summaryJSON != nil {
		r.setStatus(opID, `status=?, ended_at=?, exit_code=?, summary_json=?`,
			status, now(), exitCode, string(summaryJSON))
	} else {
		r.setStatus(opID, `status=?, ended_at=?, exit_code=?`, status, now(), exitCode)
	}
	if status == "success" || status == "warning" {
		r.captureRepoStats(p.RepoID, opID, rc, logger)
	}
	return status
}

// captureRepoStats records a repo-size history point after a size-changing
// operation. Runs under the repo lock with its own timeout (the op's context
// is already canceled by the time terminal status is written); failures only
// warn — a missing data point never fails the operation.
func (r *Runner) captureRepoStats(repoID, opID int64, rc restic.RepoConfig, logger *opLogger) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	st, err := r.restic.Stats(ctx, rc)
	if err != nil {
		logger.log("warn", "Could not record repository stats: "+err.Error())
		return
	}
	_, err = r.st.DB.ExecContext(ctx, `
		INSERT INTO repo_stats_history (repo_id, operation_id, captured_at, total_size, total_file_count, snapshots_count)
		VALUES (?, ?, ?, ?, ?, ?)`,
		repoID, opID, now(), st.TotalSize, st.TotalFileCount, st.SnapshotsCount)
	if err != nil {
		slog.Error("persist repo stats", "repo", repoID, "err", err)
	}
}

func short(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// errText extracts a human message from restic's error JSON, which is either
// a bare string or {"message": "..."}.
func errText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var obj struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &obj) == nil && obj.Message != "" {
		return obj.Message
	}
	return string(raw)
}

func formatBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}

const opSelect = `
	SELECT o.id, o.type, o.repo_id, COALESCE(r.name,''), o.plan_id, COALESCE(p.name,''),
	       o.status, o.started_at, o.ended_at, o.exit_code, o.summary_json, o.created_at
	FROM operations o
	LEFT JOIN repos r ON r.id = o.repo_id
	LEFT JOIN plans p ON p.id = o.plan_id`

func scanOp(row interface{ Scan(...any) error }) (*Operation, error) {
	var (
		op      Operation
		summary string
	)
	err := row.Scan(&op.ID, &op.Type, &op.RepoID, &op.RepoName, &op.PlanID, &op.PlanName,
		&op.Status, &op.StartedAt, &op.EndedAt, &op.ExitCode, &summary, &op.CreatedAt)
	if err != nil {
		return nil, err
	}
	if summary != "" && summary != "{}" {
		op.Summary = json.RawMessage(summary)
	}
	return &op, nil
}

// GetOperation returns one operation.
func (r *Runner) GetOperation(ctx context.Context, id int64) (*Operation, error) {
	op, err := scanOp(r.st.DB.QueryRowContext(ctx, opSelect+` WHERE o.id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return op, err
}

// OpFilter narrows ListOperations. Zero values mean "no filter" for that field.
type OpFilter struct {
	Type     string
	Status   string
	RepoID   int64
	PlanID   int64
	BeforeID int64 // only operations with id < BeforeID ("load more" cursor)
	Limit    int
}

// ListOperations returns recent operations matching f, newest first.
func (r *Runner) ListOperations(ctx context.Context, f OpFilter) ([]Operation, error) {
	limit := f.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	query := opSelect
	var where []string
	var args []any
	if f.Type != "" {
		where = append(where, "o.type=?")
		args = append(args, f.Type)
	}
	if f.Status != "" {
		where = append(where, "o.status=?")
		args = append(args, f.Status)
	}
	if f.RepoID > 0 {
		where = append(where, "o.repo_id=?")
		args = append(args, f.RepoID)
	}
	if f.PlanID > 0 {
		where = append(where, "o.plan_id=?")
		args = append(args, f.PlanID)
	}
	if f.BeforeID > 0 {
		where = append(where, "o.id<?")
		args = append(args, f.BeforeID)
	}
	if len(where) > 0 {
		query += " WHERE " + strings.Join(where, " AND ")
	}
	query += " ORDER BY o.id DESC LIMIT ?"
	args = append(args, limit)

	rows, err := r.st.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ops := []Operation{}
	for rows.Next() {
		op, err := scanOp(rows)
		if err != nil {
			return nil, err
		}
		ops = append(ops, *op)
	}
	return ops, rows.Err()
}

// GetLogs returns the persisted log lines of an operation.
func (r *Runner) GetLogs(ctx context.Context, opID int64) ([]LogLine, error) {
	rows, err := r.st.DB.QueryContext(ctx, `
		SELECT seq, ts, level, message FROM operation_logs
		WHERE operation_id=? ORDER BY seq`, opID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	lines := []LogLine{}
	for rows.Next() {
		var l LogLine
		if err := rows.Scan(&l.Seq, &l.TS, &l.Level, &l.Message); err != nil {
			return nil, err
		}
		lines = append(lines, l)
	}
	return lines, rows.Err()
}

// ResumeInterrupted marks operations left "running"/"queued" by a previous
// process as errored (called once at startup).
func (r *Runner) ResumeInterrupted(ctx context.Context) error {
	_, err := r.st.DB.ExecContext(ctx, `
		UPDATE operations SET status='error', ended_at=?
		WHERE status IN ('running','queued')`, now())
	return err
}
