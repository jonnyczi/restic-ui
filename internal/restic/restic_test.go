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

// writeStub creates an executable script echoing the given body.
func writeStub(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "restic-stub")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

// TestDiffParsesFixture uses `restic diff --json` output captured from the
// pinned restic 0.17.3 against a scratch repository (no documented schema).
func TestDiffParsesFixture(t *testing.T) {
	stub := writeStub(t, `cat <<'JSON'
{"message_type":"change","path":"/src/a.txt","modifier":"M"}
{"message_type":"change","path":"/src/new.txt","modifier":"+"}
{"message_type":"statistics","source_snapshot":"24d99e46","target_snapshot":"5a4ee8c1","changed_files":1,"added":{"files":1,"dirs":0,"others":0,"data_blobs":1,"tree_blobs":2,"bytes":1176},"removed":{"files":0,"dirs":0,"others":0,"data_blobs":1,"tree_blobs":2,"bytes":1158}}
JSON
`)
	r := &Runner{Bin: stub}
	res, err := r.Diff(context.Background(), RepoConfig{Repository: "/x", Password: "p"}, "24d99e46", "5a4ee8c1")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Changes) != 2 {
		t.Fatalf("changes = %d, want 2", len(res.Changes))
	}
	if res.Changes[0].Path != "/src/a.txt" || res.Changes[0].Modifier != "M" {
		t.Fatalf("change[0] = %+v", res.Changes[0])
	}
	if res.Changes[1].Modifier != "+" {
		t.Fatalf("change[1] = %+v", res.Changes[1])
	}
	if res.Stats == nil || res.Stats.ChangedFiles != 1 || res.Stats.Added.Bytes != 1176 {
		t.Fatalf("stats = %+v", res.Stats)
	}
	if res.Truncated {
		t.Fatal("unexpected truncation")
	}
}

func TestDiffNoChanges(t *testing.T) {
	stub := writeStub(t, `cat <<'JSON'
{"message_type":"statistics","source_snapshot":"a","target_snapshot":"b","changed_files":0,"added":{"files":0,"dirs":0,"others":0,"data_blobs":0,"tree_blobs":0,"bytes":0},"removed":{"files":0,"dirs":0,"others":0,"data_blobs":0,"tree_blobs":0,"bytes":0}}
JSON
`)
	r := &Runner{Bin: stub}
	res, err := r.Diff(context.Background(), RepoConfig{Repository: "/x", Password: "p"}, "aaaaaaaa", "bbbbbbbb")
	if err != nil {
		t.Fatal(err)
	}
	if res.Changes == nil || len(res.Changes) != 0 {
		t.Fatalf("changes = %v, want empty non-nil", res.Changes)
	}
}

// TestFindParsesFixture uses `restic find --json` output captured from the
// pinned restic 0.17.3 (an array of {matches, hits, snapshot} groups).
func TestFindParsesFixture(t *testing.T) {
	stub := writeStub(t, `cat <<'JSON'
[{"matches":[{"path":"/src/a.txt","permissions":"-rw-r--r--","type":"file","mode":420,"mtime":"2026-07-13T01:14:30.5-04:00","uid":1000,"gid":1000,"size":18,"links":1}],"hits":1,"snapshot":"24d99e46bf3b814483fdd42305ec091210d6e51ad72e5eff89307993eb1ec2a3"}]
JSON
`)
	r := &Runner{Bin: stub}
	res, err := r.Find(context.Background(), RepoConfig{Repository: "/x", Password: "p"}, "a.txt")
	if err != nil {
		t.Fatal(err)
	}
	if len(res) != 1 || res[0].Hits != 1 || len(res[0].Matches) != 1 {
		t.Fatalf("res = %+v", res)
	}
	m := res[0].Matches[0]
	if m.Path != "/src/a.txt" || m.Type != "file" || m.Size != 18 {
		t.Fatalf("match = %+v", m)
	}
}

func TestFindEmptyAndNullNormalized(t *testing.T) {
	// No matches → restic prints []; a null matches array must also normalize.
	stub := writeStub(t, `echo '[{"matches":null,"hits":0,"snapshot":"24d99e46bf3b814483fdd42305ec091210d6e51ad72e5eff89307993eb1ec2a3"}]'`)
	r := &Runner{Bin: stub}
	res, err := r.Find(context.Background(), RepoConfig{Repository: "/x", Password: "p"}, "x")
	if err != nil {
		t.Fatal(err)
	}
	if res[0].Matches == nil {
		t.Fatal("Matches is nil, want []")
	}

	stub2 := writeStub(t, `echo '[]'`)
	r2 := &Runner{Bin: stub2}
	res2, err := r2.Find(context.Background(), RepoConfig{Repository: "/x", Password: "p"}, "x")
	if err != nil {
		t.Fatal(err)
	}
	if res2 == nil || len(res2) != 0 {
		t.Fatalf("res = %v, want empty non-nil", res2)
	}
}

// TestBackupDryRun uses `backup --dry-run --json` output captured from the
// pinned restic 0.17.3 — same NDJSON as a real backup, summary marked dry_run.
func TestBackupDryRun(t *testing.T) {
	stub := writeStub(t, `cat <<'JSON'
{"message_type":"status","percent_done":1,"total_files":3,"total_bytes":60}
{"message_type":"summary","files_new":1,"files_changed":0,"files_unmodified":2,"dirs_new":0,"dirs_changed":1,"dirs_unmodified":0,"data_blobs":1,"tree_blobs":2,"data_added":1531,"data_added_packed":844,"total_files_processed":3,"total_bytes_processed":60,"total_duration":0.008,"snapshot_id":"1426bb58","dry_run":true}
JSON
`)
	r := &Runner{Bin: stub}
	p, err := r.BackupDryRun(context.Background(), RepoConfig{Repository: "/x", Password: "p"},
		[]string{"/src"}, []string{"*.tmp"}, []string{"--exclude-caches"})
	if err != nil {
		t.Fatal(err)
	}
	if p.FilesNew != 1 || p.FilesUnmodified != 2 || p.DataAdded != 1531 || p.TotalFilesProcessed != 3 {
		t.Fatalf("preview = %+v", p)
	}
}

func TestBackupDryRunExitCode3StillReturnsSummary(t *testing.T) {
	stub := writeStub(t, `cat <<'JSON'
{"message_type":"summary","files_new":1,"files_changed":0,"files_unmodified":0,"data_added":10,"total_files_processed":1,"total_bytes_processed":10,"total_duration":0.01,"dry_run":true}
JSON
echo 'permission denied' >&2
exit 3
`)
	r := &Runner{Bin: stub}
	p, err := r.BackupDryRun(context.Background(), RepoConfig{Repository: "/x", Password: "p"},
		[]string{"/src"}, nil, nil)
	if err != nil {
		t.Fatalf("exit 3 with summary should succeed, got %v", err)
	}
	if p.FilesNew != 1 {
		t.Fatalf("preview = %+v", p)
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
