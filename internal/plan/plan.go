// Package plan manages backup plans: what to back up, where to, and when.
package plan

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/jonnyczi/restic-ui/internal/schedule"
	"github.com/jonnyczi/restic-ui/internal/store"
)

// ErrNotFound is returned when a plan id does not exist.
var ErrNotFound = errors.New("plan not found")

// Retention is a restic forget policy. The zero value means "no retention".
type Retention struct {
	KeepLast    int `json:"keepLast,omitempty"`
	KeepHourly  int `json:"keepHourly,omitempty"`
	KeepDaily   int `json:"keepDaily,omitempty"`
	KeepWeekly  int `json:"keepWeekly,omitempty"`
	KeepMonthly int `json:"keepMonthly,omitempty"`
	KeepYearly  int `json:"keepYearly,omitempty"`
	// Prune runs `restic prune` after forget to reclaim space.
	Prune bool `json:"prune,omitempty"`
}

// Empty reports whether no keep rule is set.
func (r Retention) Empty() bool {
	return r.KeepLast == 0 && r.KeepHourly == 0 && r.KeepDaily == 0 &&
		r.KeepWeekly == 0 && r.KeepMonthly == 0 && r.KeepYearly == 0
}

// Args returns the restic forget --keep-* arguments for this policy.
func (r Retention) Args() []string {
	var args []string
	add := func(flag string, v int) {
		if v > 0 {
			args = append(args, flag, fmt.Sprint(v))
		}
	}
	add("--keep-last", r.KeepLast)
	add("--keep-hourly", r.KeepHourly)
	add("--keep-daily", r.KeepDaily)
	add("--keep-weekly", r.KeepWeekly)
	add("--keep-monthly", r.KeepMonthly)
	add("--keep-yearly", r.KeepYearly)
	return args
}

// BackupOptions are optional restic backup flags for a plan. The zero value
// means "no extra flags".
type BackupOptions struct {
	// UploadLimitKiB / DownloadLimitKiB throttle transfer rates (KiB/s, 0 = unlimited).
	UploadLimitKiB   int `json:"uploadLimitKiB,omitempty"`
	DownloadLimitKiB int `json:"downloadLimitKiB,omitempty"`
	// ExcludeCaches skips directories carrying a CACHEDIR.TAG file.
	ExcludeCaches bool `json:"excludeCaches,omitempty"`
	// OneFileSystem stops backup from crossing filesystem boundaries.
	OneFileSystem bool `json:"oneFileSystem,omitempty"`
}

// Args returns the restic backup flags for these options.
func (o BackupOptions) Args() []string {
	var args []string
	if o.UploadLimitKiB > 0 {
		args = append(args, "--limit-upload", fmt.Sprint(o.UploadLimitKiB))
	}
	if o.DownloadLimitKiB > 0 {
		args = append(args, "--limit-download", fmt.Sprint(o.DownloadLimitKiB))
	}
	if o.ExcludeCaches {
		args = append(args, "--exclude-caches")
	}
	if o.OneFileSystem {
		args = append(args, "--one-file-system")
	}
	return args
}

// Plan is a stored backup plan.
type Plan struct {
	ID           int64         `json:"id"`
	Name         string        `json:"name"`
	RepoID       int64         `json:"repoId"`
	RepoName     string        `json:"repoName"` // joined for display
	Sources      []string      `json:"sources"`
	Excludes     []string      `json:"excludes"`
	Tags         []string      `json:"tags"`
	ScheduleCron string        `json:"scheduleCron"` // empty = manual only
	Retention    Retention     `json:"retention"`
	Options      BackupOptions `json:"options"`
	Enabled      bool          `json:"enabled"`
	NotifyMuted  bool          `json:"notifyMuted"`
	CreatedAt    string        `json:"createdAt"`
	UpdatedAt    string        `json:"updatedAt"`
}

// Input is the create/update payload.
type Input struct {
	Name         string        `json:"name"`
	RepoID       int64         `json:"repoId"`
	Sources      []string      `json:"sources"`
	Excludes     []string      `json:"excludes"`
	Tags         []string      `json:"tags"`
	ScheduleCron string        `json:"scheduleCron"`
	Retention    Retention     `json:"retention"`
	Options      BackupOptions `json:"options"`
	Enabled      bool          `json:"enabled"`
	NotifyMuted  bool          `json:"notifyMuted"`
}

// Validate checks the input for completeness.
func (in *Input) Validate() error {
	if strings.TrimSpace(in.Name) == "" {
		return errors.New("name is required")
	}
	if in.RepoID <= 0 {
		return errors.New("a repository is required")
	}
	if len(in.Sources) == 0 {
		return errors.New("at least one source path is required")
	}
	for _, s := range in.Sources {
		if !filepath.IsAbs(s) {
			return fmt.Errorf("source %q must be an absolute path", s)
		}
	}
	if in.ScheduleCron != "" {
		if _, err := schedule.Parse(in.ScheduleCron); err != nil {
			return fmt.Errorf("invalid cron expression %q: %w", in.ScheduleCron, err)
		}
	}
	for _, t := range in.Tags {
		if strings.ContainsAny(t, ", ") {
			return fmt.Errorf("tag %q must not contain commas or spaces", t)
		}
	}
	r := in.Retention
	for _, v := range []int{r.KeepLast, r.KeepHourly, r.KeepDaily, r.KeepWeekly, r.KeepMonthly, r.KeepYearly} {
		if v < 0 {
			return errors.New("retention counts must not be negative")
		}
	}
	if in.Options.UploadLimitKiB < 0 || in.Options.DownloadLimitKiB < 0 {
		return errors.New("bandwidth limits must not be negative")
	}
	return nil
}

// Service implements plan CRUD.
type Service struct {
	st *store.Store
}

// NewService constructs a Service.
func NewService(st *store.Store) *Service { return &Service{st: st} }

func marshalList(v []string) string {
	if v == nil {
		v = []string{}
	}
	b, _ := json.Marshal(v)
	return string(b)
}

// Create stores a new plan.
func (s *Service) Create(ctx context.Context, in Input) (*Plan, error) {
	if err := in.Validate(); err != nil {
		return nil, err
	}
	retJSON, _ := json.Marshal(in.Retention)
	optJSON, _ := json.Marshal(in.Options)
	now := time.Now().UTC().Format(time.RFC3339)
	res, err := s.st.DB.ExecContext(ctx, `
		INSERT INTO plans (name, repo_id, sources_json, excludes_json, tags_json, schedule_cron, retention_json, options_json, enabled, notify_muted, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		in.Name, in.RepoID, marshalList(in.Sources), marshalList(in.Excludes),
		marshalList(in.Tags), in.ScheduleCron, string(retJSON), string(optJSON), boolToInt(in.Enabled), boolToInt(in.NotifyMuted), now, now,
	)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return nil, fmt.Errorf("a plan named %q already exists", in.Name)
		}
		if strings.Contains(err.Error(), "FOREIGN KEY") {
			return nil, errors.New("repository does not exist")
		}
		return nil, err
	}
	id, _ := res.LastInsertId()
	return s.Get(ctx, id)
}

// Update modifies a plan.
func (s *Service) Update(ctx context.Context, id int64, in Input) (*Plan, error) {
	if err := in.Validate(); err != nil {
		return nil, err
	}
	retJSON, _ := json.Marshal(in.Retention)
	optJSON, _ := json.Marshal(in.Options)
	now := time.Now().UTC().Format(time.RFC3339)
	res, err := s.st.DB.ExecContext(ctx, `
		UPDATE plans SET name=?, repo_id=?, sources_json=?, excludes_json=?, tags_json=?, schedule_cron=?, retention_json=?, options_json=?, enabled=?, notify_muted=?, updated_at=?
		WHERE id=?`,
		in.Name, in.RepoID, marshalList(in.Sources), marshalList(in.Excludes),
		marshalList(in.Tags), in.ScheduleCron, string(retJSON), string(optJSON), boolToInt(in.Enabled), boolToInt(in.NotifyMuted), now, id,
	)
	if err != nil {
		if strings.Contains(err.Error(), "FOREIGN KEY") {
			return nil, errors.New("repository does not exist")
		}
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, ErrNotFound
	}
	return s.Get(ctx, id)
}

// SetEnabled flips just the enabled flag.
func (s *Service) SetEnabled(ctx context.Context, id int64, enabled bool) error {
	res, err := s.st.DB.ExecContext(ctx,
		`UPDATE plans SET enabled=?, updated_at=? WHERE id=?`,
		boolToInt(enabled), time.Now().UTC().Format(time.RFC3339), id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// Delete removes a plan.
func (s *Service) Delete(ctx context.Context, id int64) error {
	res, err := s.st.DB.ExecContext(ctx, `DELETE FROM plans WHERE id=?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

const planSelect = `
	SELECT p.id, p.name, p.repo_id, r.name, p.sources_json, p.excludes_json,
	       p.tags_json, p.schedule_cron, p.retention_json, p.options_json, p.enabled, p.notify_muted, p.created_at, p.updated_at
	FROM plans p JOIN repos r ON r.id = p.repo_id`

func scanPlan(row interface{ Scan(...any) error }) (*Plan, error) {
	var (
		p                                           Plan
		sources, excludes, tags, retention, options string
		enabled, notifyMuted                        int
	)
	err := row.Scan(&p.ID, &p.Name, &p.RepoID, &p.RepoName, &sources, &excludes,
		&tags, &p.ScheduleCron, &retention, &options, &enabled, &notifyMuted, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return nil, err
	}
	p.Enabled = enabled != 0
	p.NotifyMuted = notifyMuted != 0
	if err := json.Unmarshal([]byte(sources), &p.Sources); err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(excludes), &p.Excludes); err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(tags), &p.Tags); err != nil {
		return nil, err
	}
	if retention != "" {
		if err := json.Unmarshal([]byte(retention), &p.Retention); err != nil {
			return nil, err
		}
	}
	if options != "" {
		if err := json.Unmarshal([]byte(options), &p.Options); err != nil {
			return nil, err
		}
	}
	return &p, nil
}

// Get returns one plan.
func (s *Service) Get(ctx context.Context, id int64) (*Plan, error) {
	p, err := scanPlan(s.st.DB.QueryRowContext(ctx, planSelect+` WHERE p.id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return p, err
}

// List returns all plans.
func (s *Service) List(ctx context.Context) ([]Plan, error) {
	rows, err := s.st.DB.QueryContext(ctx, planSelect+` ORDER BY p.name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	plans := []Plan{}
	for rows.Next() {
		p, err := scanPlan(rows)
		if err != nil {
			return nil, err
		}
		plans = append(plans, *p)
	}
	return plans, rows.Err()
}

// ListScheduled returns enabled plans that have a cron schedule.
func (s *Service) ListScheduled(ctx context.Context) ([]Plan, error) {
	rows, err := s.st.DB.QueryContext(ctx, planSelect+` WHERE p.enabled=1 AND p.schedule_cron != ''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	plans := []Plan{}
	for rows.Next() {
		p, err := scanPlan(rows)
		if err != nil {
			return nil, err
		}
		plans = append(plans, *p)
	}
	return plans, rows.Err()
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
