package restic

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestCommandEnvAndArgs(t *testing.T) {
	r := &Runner{Bin: "restic", CacheDir: "/tmp/cache-x"}
	rc := RepoConfig{
		Repository: "sftp://u@h:22//repo",
		Password:   "pw",
		Env:        []string{"FOO=bar"},
		ExtraArgs:  []string{"-o", "sftp.command=ssh h"},
	}
	cmd := r.Command(context.Background(), rc, "snapshots", "--json")

	wantArgs := []string{"snapshots", "--json", "-o", "sftp.command=ssh h"}
	if got := cmd.Args[1:]; !slices.Equal(got, wantArgs) {
		t.Errorf("args = %q, want %q", got, wantArgs)
	}

	// Only inspect entries we appended, not the inherited environment.
	added := cmd.Env[len(os.Environ()):]
	for _, want := range []string{
		"RESTIC_REPOSITORY=sftp://u@h:22//repo",
		"RESTIC_PASSWORD=pw",
		"RESTIC_CACHE_DIR=/tmp/cache-x",
		"FOO=bar",
	} {
		if !slices.Contains(added, want) {
			t.Errorf("env missing %q (added entries: %q)", want, added)
		}
	}
}

// TestForgetDryRun checks parsing of `forget --dry-run --json`, whose shape
// (an array of {host, paths, tags, keep, remove} groups, each snapshot entry
// carrying the same fields as `restic snapshots --json`) was captured from a
// real restic 0.18.1 binary against a scratch repository — there is no
// documented schema for this to test against otherwise.
func TestForgetDryRun(t *testing.T) {
	script := `#!/bin/sh
echo "ARGS: $@" >&2
cat <<'JSON'
[{"tags":null,"host":"h","paths":["/src"],"keep":[{"time":"2026-07-13T01:14:32Z","paths":["/src"],"hostname":"h","username":"u","id":"5a4ee8c19db2caca8ceb780095b74e2ab64f2d08095f0b9376fcebb267069989","short_id":"5a4ee8c1"},{"time":"2026-07-13T01:14:31Z","paths":["/src"],"hostname":"h","username":"u","id":"c3be4ef1217c628cef8ff2a27963248a1b8fea9ca312d2ce1383048a99f09b2f","short_id":"c3be4ef1"}],"remove":[{"time":"2026-07-13T01:14:30Z","paths":["/src"],"hostname":"h","username":"u","id":"24d99e46bf3b814483fdd42305ec091210d6e51ad72e5eff89307993eb1ec2a3","short_id":"24d99e46"}]}]
JSON
`
	path := filepath.Join(t.TempDir(), "restic-stub")
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	r := &Runner{Bin: path}
	groups, err := r.ForgetDryRun(context.Background(),
		RepoConfig{Repository: "/tmp/x", Password: "p"},
		[]string{"--keep-last", "2", "--path", "/src"})
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) != 1 {
		t.Fatalf("groups = %d, want 1", len(groups))
	}
	g := groups[0]
	if len(g.Keep) != 2 || len(g.Remove) != 1 {
		t.Fatalf("keep=%d remove=%d, want 2/1", len(g.Keep), len(g.Remove))
	}
	if g.Remove[0].ShortID != "24d99e46" {
		t.Errorf("remove[0].ShortID = %q, want 24d99e46", g.Remove[0].ShortID)
	}
}

// TestForgetDryRunNormalizesNullRemove reproduces a real response captured
// against restic 0.18.1 when a policy removes nothing: the "remove" key is
// JSON null, not []. Callers must never see a nil slice here.
func TestForgetDryRunNormalizesNullRemove(t *testing.T) {
	script := `#!/bin/sh
cat <<'JSON'
[{"host":"h","paths":["/src"],"tags":null,"keep":[{"id":"b83f4e21","short_id":"b83f4e21","time":"2026-07-13T06:02:08Z","paths":["/src"],"hostname":"h","username":"u"}],"remove":null}]
JSON
`
	path := filepath.Join(t.TempDir(), "restic-stub")
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	r := &Runner{Bin: path}
	groups, err := r.ForgetDryRun(context.Background(),
		RepoConfig{Repository: "/tmp/x", Password: "p"},
		[]string{"--keep-last", "1", "--path", "/src"})
	if err != nil {
		t.Fatal(err)
	}
	if groups[0].Remove == nil {
		t.Fatal("Remove is nil, want a non-nil empty slice")
	}
	if len(groups[0].Remove) != 0 {
		t.Fatalf("len(Remove) = %d, want 0", len(groups[0].Remove))
	}
}

func TestCommandNoCacheDirWhenUnset(t *testing.T) {
	r := &Runner{Bin: "restic"}
	cmd := r.Command(context.Background(), RepoConfig{Repository: "x", Password: "y"}, "snapshots")

	added := cmd.Env[len(os.Environ()):]
	for _, e := range added {
		if strings.HasPrefix(e, "RESTIC_CACHE_DIR=") {
			t.Errorf("unexpected cache dir entry %q", e)
		}
	}
}
