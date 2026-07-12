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

// Check verifies repository integrity, returning restic's textual report.
func (r *Runner) Check(ctx context.Context, repo RepoConfig) (string, error) {
	out, err := r.Run(ctx, repo, "check")
	return string(out), err
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
