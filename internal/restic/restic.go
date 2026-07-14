// Package restic wraps the restic CLI: it assembles repository locations,
// credentials, and arguments per backend, executes the binary, and decodes its
// --json output into typed results.
package restic

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
)

// Backend identifies a supported repository backend.
type Backend string

const (
	BackendLocal  Backend = "local"
	BackendS3     Backend = "s3"
	BackendSFTP   Backend = "sftp"
	BackendRclone Backend = "rclone"
)

// ValidBackend reports whether b is a supported backend type.
func ValidBackend(b Backend) bool {
	switch b {
	case BackendLocal, BackendS3, BackendSFTP, BackendRclone:
		return true
	}
	return false
}

// RepoConfig is everything needed to point restic at one repository. It is
// assembled per-invocation from stored config + decrypted secrets and never
// persisted in this form.
type RepoConfig struct {
	// Repository is the -r/--repo value, e.g. "/repos/media" or "s3:host/bucket".
	Repository string
	// Password is the restic repository password.
	Password string
	// Env holds extra environment (e.g. AWS_ACCESS_KEY_ID=...).
	Env []string
	// ExtraArgs are appended to every invocation (e.g. -o sftp.command=...).
	ExtraArgs []string
}

// Runner executes restic commands.
type Runner struct {
	// Bin is the restic executable (path or PATH name).
	Bin string
	// CacheDir, when set, is exported as RESTIC_CACHE_DIR so restic never
	// falls back to $HOME/.cache/restic (the container user has no home).
	CacheDir string
}

// Error carries restic's exit code and captured stderr for classification.
type Error struct {
	ExitCode int
	Stderr   string
}

func (e *Error) Error() string {
	msg := strings.TrimSpace(e.Stderr)
	if msg == "" {
		msg = fmt.Sprintf("restic exited with code %d", e.ExitCode)
	}
	return msg
}

// Friendly maps well-known restic exit codes to actionable messages.
func (e *Error) Friendly() string {
	switch e.ExitCode {
	case 10:
		return "repository does not exist (has it been initialized?)"
	case 11:
		return "repository is locked by another process (try unlock)"
	case 12:
		return "wrong repository password"
	}
	return e.Error()
}

// Command builds an *exec.Cmd for the given repo and arguments. The repository
// location and password travel via environment variables so they never appear
// in the process argv (visible in `ps`).
func (r *Runner) Command(ctx context.Context, repo RepoConfig, args ...string) *exec.Cmd {
	full := append([]string{}, args...)
	full = append(full, repo.ExtraArgs...)
	cmd := exec.CommandContext(ctx, r.Bin, full...)
	cmd.Env = append(os.Environ(),
		"RESTIC_REPOSITORY="+repo.Repository,
		"RESTIC_PASSWORD="+repo.Password,
	)
	if r.CacheDir != "" {
		cmd.Env = append(cmd.Env, "RESTIC_CACHE_DIR="+r.CacheDir)
	}
	cmd.Env = append(cmd.Env, repo.Env...)
	return cmd
}

// Run executes restic and returns stdout. Non-zero exits become *Error.
func (r *Runner) Run(ctx context.Context, repo RepoConfig, args ...string) ([]byte, error) {
	cmd := r.Command(ctx, repo, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return stdout.Bytes(), &Error{ExitCode: exitErr.ExitCode(), Stderr: stderr.String()}
		}
		return nil, fmt.Errorf("run restic: %w", err)
	}
	return stdout.Bytes(), nil
}

// RunJSON executes restic with --json and unmarshals stdout into v.
func (r *Runner) RunJSON(ctx context.Context, repo RepoConfig, v any, args ...string) error {
	out, err := r.Run(ctx, repo, append(args, "--json")...)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(out, v); err != nil {
		return fmt.Errorf("parse restic json output: %w", err)
	}
	return nil
}

// --- Typed results ---

// Snapshot is one entry of `restic snapshots --json`.
type Snapshot struct {
	ID       string   `json:"id"`
	ShortID  string   `json:"short_id"`
	Time     string   `json:"time"`
	Hostname string   `json:"hostname"`
	Username string   `json:"username"`
	Paths    []string `json:"paths"`
	Tags     []string `json:"tags,omitempty"`
	Summary  *struct {
		TotalFilesProcessed int64 `json:"total_files_processed"`
		TotalBytesProcessed int64 `json:"total_bytes_processed"`
	} `json:"summary,omitempty"`
}

// Stats is the output of `restic stats --json`.
type Stats struct {
	TotalSize      int64 `json:"total_size"`
	TotalFileCount int64 `json:"total_file_count"`
	SnapshotsCount int64 `json:"snapshots_count"`
}

// ForgetGroup is one entry of `restic forget --dry-run --json`: snapshots
// sharing a host/paths/tags grouping, split into what a retention policy
// would keep versus remove.
type ForgetGroup struct {
	Host   string     `json:"host"`
	Paths  []string   `json:"paths"`
	Tags   []string   `json:"tags"`
	Keep   []Snapshot `json:"keep"`
	Remove []Snapshot `json:"remove"`
}

// --- High-level operations ---

// Init initializes a new repository.
func (r *Runner) Init(ctx context.Context, repo RepoConfig) error {
	_, err := r.Run(ctx, repo, "init")
	return err
}

// CatConfig fetches the repository config blob — the cheapest way to prove the
// repo is reachable and the password is correct.
func (r *Runner) CatConfig(ctx context.Context, repo RepoConfig) error {
	_, err := r.Run(ctx, repo, "cat", "config")
	return err
}

// Snapshots lists snapshots, newest first.
func (r *Runner) Snapshots(ctx context.Context, repo RepoConfig) ([]Snapshot, error) {
	var snaps []Snapshot
	if err := r.RunJSON(ctx, repo, &snaps, "snapshots"); err != nil {
		return nil, err
	}
	// restic returns oldest-first; the UI wants newest-first.
	for i, j := 0, len(snaps)-1; i < j; i, j = i+1, j-1 {
		snaps[i], snaps[j] = snaps[j], snaps[i]
	}
	return snaps, nil
}

// Stats reports restore-size statistics for the whole repository.
func (r *Runner) Stats(ctx context.Context, repo RepoConfig) (*Stats, error) {
	var st Stats
	if err := r.RunJSON(ctx, repo, &st, "stats"); err != nil {
		return nil, err
	}
	return &st, nil
}

// LsNode is one entry from `restic ls --json`.
type LsNode struct {
	Name  string `json:"name"`
	Type  string `json:"type"` // file | dir | symlink | ...
	Path  string `json:"path"`
	Size  int64  `json:"size"`
	Mtime string `json:"mtime"`
}

// Ls lists the direct children of path inside a snapshot (non-recursive).
func (r *Runner) Ls(ctx context.Context, repo RepoConfig, snapshotID, path string) ([]LsNode, error) {
	if path == "" {
		path = "/"
	}
	out, err := r.Run(ctx, repo, "ls", snapshotID, path, "--json")
	if err != nil {
		return nil, err
	}

	// Output is NDJSON: a snapshot header line, then one node per line.
	nodes := []LsNode{}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var probe struct {
			MessageType string `json:"message_type"`
			StructType  string `json:"struct_type"` // older restic versions
			LsNode
		}
		if err := json.Unmarshal([]byte(line), &probe); err != nil {
			continue
		}
		kind := probe.MessageType
		if kind == "" {
			kind = probe.StructType
		}
		if kind != "node" || probe.Path == path {
			continue // skip header and the listed dir itself
		}
		nodes = append(nodes, probe.LsNode)
	}
	// Directories first, then alphabetical.
	sort.Slice(nodes, func(i, j int) bool {
		if (nodes[i].Type == "dir") != (nodes[j].Type == "dir") {
			return nodes[i].Type == "dir"
		}
		return nodes[i].Name < nodes[j].Name
	})
	return nodes, nil
}

// DumpCommand returns a command streaming a file (raw) or directory (tar)
// from a snapshot to stdout. The caller wires up stdout and runs it.
func (r *Runner) DumpCommand(ctx context.Context, repo RepoConfig, snapshotID, path string) *exec.Cmd {
	return r.Command(ctx, repo, "dump", snapshotID, path)
}

// Unlock removes stale locks.
func (r *Runner) Unlock(ctx context.Context, repo RepoConfig) error {
	_, err := r.Run(ctx, repo, "unlock")
	return err
}

// maxDiffChanges caps how many per-path changes Diff returns — a diff
// between distant snapshots can list hundreds of thousands of paths.
const maxDiffChanges = 1000

// DiffChange is one changed path between two snapshots. Modifier is restic's
// change marker (+ added, - removed, M modified, T type change, ...).
type DiffChange struct {
	Path     string `json:"path"`
	Modifier string `json:"modifier"`
}

// DiffSide aggregates one direction of a diff's statistics.
type DiffSide struct {
	Files int64 `json:"files"`
	Dirs  int64 `json:"dirs"`
	Bytes int64 `json:"bytes"`
}

// DiffStats is the summary line of `restic diff --json`.
type DiffStats struct {
	SourceSnapshot string   `json:"source_snapshot"`
	TargetSnapshot string   `json:"target_snapshot"`
	ChangedFiles   int64    `json:"changed_files"`
	Added          DiffSide `json:"added"`
	Removed        DiffSide `json:"removed"`
}

// DiffResult is a parsed snapshot comparison.
type DiffResult struct {
	Changes   []DiffChange `json:"changes"`
	Truncated bool         `json:"truncated"`
	Stats     *DiffStats   `json:"stats,omitempty"`
}

// Diff compares two snapshots. Output is NDJSON: one "change" message per
// path plus a final "statistics" message (shape captured from restic 0.17.3;
// there is no documented schema).
func (r *Runner) Diff(ctx context.Context, repo RepoConfig, fromID, toID string) (*DiffResult, error) {
	out, err := r.Run(ctx, repo, "diff", fromID, toID, "--json")
	if err != nil {
		return nil, err
	}
	res := &DiffResult{Changes: []DiffChange{}}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var probe struct {
			MessageType string `json:"message_type"`
			DiffChange
			DiffStats
		}
		if json.Unmarshal([]byte(line), &probe) != nil {
			continue
		}
		switch probe.MessageType {
		case "change":
			if len(res.Changes) >= maxDiffChanges {
				res.Truncated = true
				continue
			}
			res.Changes = append(res.Changes, probe.DiffChange)
		case "statistics":
			st := probe.DiffStats
			res.Stats = &st
		}
	}
	return res, nil
}

// FindMatch is one matched node inside a snapshot.
type FindMatch struct {
	Path  string `json:"path"`
	Type  string `json:"type"`
	Size  int64  `json:"size"`
	Mtime string `json:"mtime"`
}

// FindResult groups a pattern's matches by snapshot.
type FindResult struct {
	Snapshot string      `json:"snapshot"`
	Hits     int64       `json:"hits"`
	Matches  []FindMatch `json:"matches"`
}

// Find locates a filename pattern across all snapshots, newest first.
// (restic's own group order varies between versions; sorted here by scanning
// snapshot list order is unavailable, so callers get input order normalized
// only for nil slices — the UI resolves times from its snapshot list.)
func (r *Runner) Find(ctx context.Context, repo RepoConfig, pattern string) ([]FindResult, error) {
	var results []FindResult
	if err := r.RunJSON(ctx, repo, &results, "find", pattern); err != nil {
		return nil, err
	}
	if results == nil {
		results = []FindResult{}
	}
	for i := range results {
		if results[i].Matches == nil {
			results[i].Matches = []FindMatch{}
		}
	}
	return results, nil
}

// BackupPreview is the summary of a `backup --dry-run --json` run
// (restic-native snake_case, like Operation summaries).
type BackupPreview struct {
	FilesNew            int64   `json:"files_new"`
	FilesChanged        int64   `json:"files_changed"`
	FilesUnmodified     int64   `json:"files_unmodified"`
	DataAdded           int64   `json:"data_added"`
	TotalFilesProcessed int64   `json:"total_files_processed"`
	TotalBytesProcessed int64   `json:"total_bytes_processed"`
	TotalDuration       float64 `json:"total_duration"`
}

// BackupDryRun reports what a backup would do without writing anything.
// extraFlags are additional backup flags (e.g. --exclude-caches). The stream
// is the same NDJSON a real backup emits; only the final summary line is
// kept. Exit code 3 (some files unreadable) still produces a summary and is
// treated as a successful preview.
func (r *Runner) BackupDryRun(ctx context.Context, repo RepoConfig, sources, excludes, extraFlags []string) (*BackupPreview, error) {
	args := append([]string{"backup"}, sources...)
	for _, e := range excludes {
		args = append(args, "--exclude", e)
	}
	args = append(args, extraFlags...)
	args = append(args, "--dry-run", "--json")

	out, runErr := r.Run(ctx, repo, args...)
	var preview *BackupPreview
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var probe struct {
			MessageType string `json:"message_type"`
			BackupPreview
		}
		if json.Unmarshal([]byte(line), &probe) != nil || probe.MessageType != "summary" {
			continue
		}
		p := probe.BackupPreview
		preview = &p
	}
	if preview == nil {
		if runErr != nil {
			return nil, runErr
		}
		return nil, errors.New("restic produced no backup summary")
	}
	if runErr != nil {
		var e *Error
		if errors.As(runErr, &e) && e.ExitCode == 3 {
			return preview, nil // partial read errors; the preview is still valid
		}
		return nil, runErr
	}
	return preview, nil
}

// ForgetDryRun reports which snapshots a `forget` policy would keep or
// remove, without deleting anything. forgetArgs are the --keep-* / --path /
// etc. flags (no "forget" or "--dry-run" prefix — those are added here).
func (r *Runner) ForgetDryRun(ctx context.Context, repo RepoConfig, forgetArgs []string) ([]ForgetGroup, error) {
	var groups []ForgetGroup
	args := append([]string{"forget", "--dry-run"}, forgetArgs...)
	if err := r.RunJSON(ctx, repo, &groups, args...); err != nil {
		return nil, err
	}
	// restic omits "keep"/"remove" (JSON null) when nothing falls in that
	// bucket — normalize to [] so callers never have to special-case null.
	for i := range groups {
		if groups[i].Keep == nil {
			groups[i].Keep = []Snapshot{}
		}
		if groups[i].Remove == nil {
			groups[i].Remove = []Snapshot{}
		}
	}
	return groups, nil
}
