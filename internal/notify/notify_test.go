package notify

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/jonnyczi/restic-ui/internal/crypto"
	"github.com/jonnyczi/restic-ui/internal/ops"
	"github.com/jonnyczi/restic-ui/internal/plan"
	"github.com/jonnyczi/restic-ui/internal/repo"
	"github.com/jonnyczi/restic-ui/internal/restic"
	"github.com/jonnyczi/restic-ui/internal/store"
)

func newTestEnv(t *testing.T) (*Service, *plan.Service, int64) {
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
	plans := plan.NewService(st)
	return NewService(st, plans), plans, rp.ID
}

// TestNotifyOpRespectsPlanMute checks that NotifyOp skips sending for a
// muted plan even though the global settings would otherwise allow it, and
// still sends for an unmuted plan under the same settings.
func TestNotifyOpRespectsPlanMute(t *testing.T) {
	svc, plans, repoID := newTestEnv(t)
	ctx := context.Background()

	var calls int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	if err := svc.Save(ctx, Settings{
		AppriseAPIURL:   server.URL,
		NotifyOnSuccess: true,
		NotifyOnFailure: true,
	}); err != nil {
		t.Fatal(err)
	}

	muted, err := plans.Create(ctx, plan.Input{
		Name: "muted", RepoID: repoID, Sources: []string{"/a"}, Enabled: true, NotifyMuted: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	loud, err := plans.Create(ctx, plan.Input{
		Name: "loud", RepoID: repoID, Sources: []string{"/a"}, Enabled: true, NotifyMuted: false,
	})
	if err != nil {
		t.Fatal(err)
	}

	svc.NotifyOp(ops.Operation{ID: 1, Type: "backup", Status: "success", PlanID: &muted.ID, PlanName: muted.Name})
	if n := atomic.LoadInt32(&calls); n != 0 {
		t.Fatalf("muted plan: got %d notification(s), want 0", n)
	}

	svc.NotifyOp(ops.Operation{ID: 2, Type: "backup", Status: "success", PlanID: &loud.ID, PlanName: loud.Name})
	if n := atomic.LoadInt32(&calls); n != 1 {
		t.Fatalf("unmuted plan: got %d notification(s), want 1", n)
	}

	// No plan (e.g. a manual repo check) is never muted.
	svc.NotifyOp(ops.Operation{ID: 3, Type: "check", Status: "success"})
	if n := atomic.LoadInt32(&calls); n != 2 {
		t.Fatalf("no-plan op: got %d notification(s), want 2", n)
	}
}
