package plan

import (
	"context"
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
