package plan

import (
	"context"
	"strings"
	"testing"

	"github.com/jonnyczi/restic-ui/internal/crypto"
	"github.com/jonnyczi/restic-ui/internal/repo"
	"github.com/jonnyczi/restic-ui/internal/restic"
	"github.com/jonnyczi/restic-ui/internal/store"
)

func newTestEnv(t *testing.T) (*Service, int64) {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	box, _ := crypto.NewBox("k")
	repos := repo.NewService(st, box, dir)
	rp, err := repos.Create(context.Background(), repo.Input{
		Name: "r", BackendType: restic.BackendLocal, Password: "p",
		Config: repo.Config{Path: "/repos/x"},
	})
	if err != nil {
		t.Fatal(err)
	}
	return NewService(st), rp.ID
}

func TestValidation(t *testing.T) {
	_, repoID := newTestEnv(t)
	bad := []Input{
		{Name: "", RepoID: repoID, Sources: []string{"/a"}},
		{Name: "x", RepoID: 0, Sources: []string{"/a"}},
		{Name: "x", RepoID: repoID, Sources: nil},
		{Name: "x", RepoID: repoID, Sources: []string{"relative/path"}},
		{Name: "x", RepoID: repoID, Sources: []string{"/a"}, ScheduleCron: "not a cron"},
		{Name: "x", RepoID: repoID, Sources: []string{"/a"}, ScheduleCron: "0 2 * * * *"}, // 6 fields
		{Name: "x", RepoID: repoID, Sources: []string{"/a"}, Tags: []string{"has space"}},
	}
	for i, in := range bad {
		if err := in.Validate(); err == nil {
			t.Fatalf("case %d: expected validation error", i)
		}
	}
	good := Input{Name: "x", RepoID: repoID, Sources: []string{"/a"}, ScheduleCron: "0 2 * * *"}
	if err := good.Validate(); err != nil {
		t.Fatalf("valid input rejected: %v", err)
	}
}

func TestCRUDAndScheduledList(t *testing.T) {
	svc, repoID := newTestEnv(t)
	ctx := context.Background()

	p, err := svc.Create(ctx, Input{
		Name: "nightly", RepoID: repoID, Sources: []string{"/data"},
		ScheduleCron: "0 2 * * *", Enabled: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if p.RepoName != "r" {
		t.Fatalf("repoName not joined: %+v", p)
	}

	// Manual-only plan (no cron) must not appear in the scheduled list.
	if _, err := svc.Create(ctx, Input{
		Name: "manual", RepoID: repoID, Sources: []string{"/data"}, Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	// Disabled plan with cron must not appear either.
	if _, err := svc.Create(ctx, Input{
		Name: "disabled", RepoID: repoID, Sources: []string{"/data"},
		ScheduleCron: "0 3 * * *", Enabled: false,
	}); err != nil {
		t.Fatal(err)
	}

	scheduled, err := svc.ListScheduled(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(scheduled) != 1 || scheduled[0].Name != "nightly" {
		t.Fatalf("scheduled = %+v, want just nightly", scheduled)
	}

	// Toggle + delete.
	if err := svc.SetEnabled(ctx, p.ID, false); err != nil {
		t.Fatal(err)
	}
	if scheduled, _ = svc.ListScheduled(ctx); len(scheduled) != 0 {
		t.Fatal("disabled plan still scheduled")
	}
	if err := svc.Delete(ctx, p.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Get(ctx, p.ID); err != ErrNotFound {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestBackupOptionsArgs(t *testing.T) {
	cases := []struct {
		name string
		opts BackupOptions
		want []string
	}{
		{"zero value", BackupOptions{}, nil},
		{"upload only", BackupOptions{UploadLimitKiB: 512}, []string{"--limit-upload", "512"}},
		{"download only", BackupOptions{DownloadLimitKiB: 1024}, []string{"--limit-download", "1024"}},
		{"both toggles", BackupOptions{ExcludeCaches: true, OneFileSystem: true},
			[]string{"--exclude-caches", "--one-file-system"}},
		{"everything", BackupOptions{UploadLimitKiB: 100, DownloadLimitKiB: 200, ExcludeCaches: true, OneFileSystem: true},
			[]string{"--limit-upload", "100", "--limit-download", "200", "--exclude-caches", "--one-file-system"}},
	}
	for _, c := range cases {
		got := c.opts.Args()
		if strings.Join(got, " ") != strings.Join(c.want, " ") {
			t.Errorf("%s: Args() = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestBackupOptionsRoundTripAndValidation(t *testing.T) {
	svc, repoID := newTestEnv(t)
	ctx := context.Background()

	opts := BackupOptions{UploadLimitKiB: 512, ExcludeCaches: true}
	created, err := svc.Create(ctx, Input{
		Name: "opt", RepoID: repoID, Sources: []string{"/a"}, Options: opts, Enabled: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.Options != opts {
		t.Fatalf("create: options = %+v, want %+v", created.Options, opts)
	}

	opts2 := BackupOptions{DownloadLimitKiB: 99, OneFileSystem: true}
	updated, err := svc.Update(ctx, created.ID, Input{
		Name: "opt", RepoID: repoID, Sources: []string{"/a"}, Options: opts2, Enabled: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Options != opts2 {
		t.Fatalf("update: options = %+v, want %+v", updated.Options, opts2)
	}

	if _, err := svc.Create(ctx, Input{
		Name: "neg", RepoID: repoID, Sources: []string{"/a"},
		Options: BackupOptions{UploadLimitKiB: -1},
	}); err == nil {
		t.Fatal("negative limit accepted")
	}
}

func TestDeletingRepoCascadesPlans(t *testing.T) {
	svc, repoID := newTestEnv(t)
	ctx := context.Background()
	p, err := svc.Create(ctx, Input{Name: "x", RepoID: repoID, Sources: []string{"/d"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.st.DB.Exec(`DELETE FROM repos WHERE id=?`, repoID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Get(ctx, p.ID); err != ErrNotFound {
		t.Fatalf("plan should cascade-delete with repo, got %v", err)
	}
}
