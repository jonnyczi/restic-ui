package ops

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jonnyczi/restic-ui/internal/crypto"
	"github.com/jonnyczi/restic-ui/internal/plan"
	"github.com/jonnyczi/restic-ui/internal/repo"
	"github.com/jonnyczi/restic-ui/internal/restic"
	"github.com/jonnyczi/restic-ui/internal/store"
)

// stubRestic writes an executable script that mimics `restic backup --json`
// output, then exits with the given code.
func stubRestic(t *testing.T, exitCode int) string {
	t.Helper()
	script := `#!/bin/sh
echo "ARGS: $@"
echo '{"message_type":"status","percent_done":0.5,"total_files":10,"files_done":5,"total_bytes":1000,"bytes_done":500}'
echo '{"message_type":"summary","snapshot_id":"abcdef1234567890","files_new":8,"files_changed":1,"files_unmodified":1,"data_added":12345,"total_files_processed":10,"total_bytes_processed":1000,"total_duration":0.5}'
`
	if exitCode != 0 {
		script += "echo 'stub failure detail' >&2\n"
	}
	script += "exit " + map[int]string{0: "0", 1: "1", 3: "3"}[exitCode] + "\n"

	path := filepath.Join(t.TempDir(), "restic-stub")
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func setup(t *testing.T, resticBin string) (*Runner, *Hub, int64, int64) {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	box, _ := crypto.NewBox("k")
	repos := repo.NewService(st, box, dir)
	plans := plan.NewService(st)
	hub := NewHub()
	runner := NewRunner(st, repos, plans, &restic.Runner{Bin: resticBin}, hub)

	ctx := context.Background()
	rp, err := repos.Create(ctx, repo.Input{
		Name: "r", BackendType: restic.BackendLocal, Password: "p",
		Config: repo.Config{Path: "/tmp/fake-repo"},
	})
	if err != nil {
		t.Fatal(err)
	}
	p, err := plans.Create(ctx, plan.Input{
		Name: "pl", RepoID: rp.ID, Sources: []string{"/data"},
		Excludes: []string{"*.tmp"}, Tags: []string{"nightly"}, Enabled: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	return runner, hub, p.ID, rp.ID
}

// waitForStatus polls until the op reaches a terminal status.
func waitForStatus(t *testing.T, r *Runner, opID int64) *Operation {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		op, err := r.GetOperation(context.Background(), opID)
		if err != nil {
			t.Fatal(err)
		}
		switch op.Status {
		case "success", "warning", "error", "canceled":
			return op
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("operation did not finish in time")
	return nil
}

func TestBackupSuccessPersistsSummaryAndLogs(t *testing.T) {
	runner, hub, planID, _ := setup(t, stubRestic(t, 0))
	events, cancelSub := hub.Subscribe()
	defer cancelSub()

	op, err := runner.EnqueueBackup(context.Background(), planID)
	if err != nil {
		t.Fatal(err)
	}
	final := waitForStatus(t, runner, op.ID)

	if final.Status != "success" {
		t.Fatalf("status = %q, want success", final.Status)
	}
	if final.Summary == nil {
		t.Fatal("summary not persisted")
	}
	var sum struct {
		SnapshotID string `json:"snapshot_id"`
	}
	if err := json.Unmarshal(final.Summary, &sum); err != nil || sum.SnapshotID != "abcdef1234567890" {
		t.Fatalf("summary content wrong: %s", final.Summary)
	}

	logs, err := runner.GetLogs(context.Background(), op.ID)
	if err != nil || len(logs) == 0 {
		t.Fatalf("expected logs, got %v err=%v", logs, err)
	}
	joined := ""
	for _, l := range logs {
		joined += l.Message + "\n"
	}
	if !strings.Contains(joined, "Snapshot abcdef12 saved") {
		t.Fatalf("missing summary log line in:\n%s", joined)
	}
	if !strings.Contains(joined, "completed successfully") {
		t.Fatalf("missing completion line in:\n%s", joined)
	}

	// The hub must have seen op status events and at least one progress event.
	var sawProgress, sawRunning, sawTerminal bool
	timeout := time.After(2 * time.Second)
drain:
	for {
		select {
		case ev := <-events:
			switch ev.Type {
			case "progress":
				sawProgress = true
			case "op":
				if ev.Op.Status == "running" {
					sawRunning = true
				}
				if ev.Op.Status == "success" {
					sawTerminal = true
					break drain
				}
			}
		case <-timeout:
			break drain
		}
	}
	if !sawProgress || !sawRunning || !sawTerminal {
		t.Fatalf("events missing: progress=%v running=%v terminal=%v", sawProgress, sawRunning, sawTerminal)
	}
}

func TestBackupWarningExitCode3(t *testing.T) {
	runner, _, planID, _ := setup(t, stubRestic(t, 3))
	op, err := runner.EnqueueBackup(context.Background(), planID)
	if err != nil {
		t.Fatal(err)
	}
	final := waitForStatus(t, runner, op.ID)
	if final.Status != "warning" {
		t.Fatalf("status = %q, want warning", final.Status)
	}
	if final.ExitCode == nil || *final.ExitCode != 3 {
		t.Fatalf("exit code = %v, want 3", final.ExitCode)
	}
}

func TestBackupErrorExitCode1(t *testing.T) {
	runner, _, planID, _ := setup(t, stubRestic(t, 1))
	op, err := runner.EnqueueBackup(context.Background(), planID)
	if err != nil {
		t.Fatal(err)
	}
	final := waitForStatus(t, runner, op.ID)
	if final.Status != "error" {
		t.Fatalf("status = %q, want error", final.Status)
	}
	// stderr content must land in the logs.
	logs, _ := runner.GetLogs(context.Background(), op.ID)
	found := false
	for _, l := range logs {
		if strings.Contains(l.Message, "stub failure detail") {
			found = true
		}
	}
	if !found {
		t.Fatal("stderr not captured in logs")
	}
}

func TestForgetSnapshotSuccess(t *testing.T) {
	runner, _, _, repoID := setup(t, stubRestic(t, 0))
	op, err := runner.EnqueueForgetSnapshot(context.Background(), repoID, "abcdef12")
	if err != nil {
		t.Fatal(err)
	}
	if op.Type != "forget" {
		t.Fatalf("type = %q, want forget", op.Type)
	}
	final := waitForStatus(t, runner, op.ID)
	if final.Status != "success" {
		t.Fatalf("status = %q, want success", final.Status)
	}

	logs, _ := runner.GetLogs(context.Background(), op.ID)
	joined := ""
	for _, l := range logs {
		joined += l.Message + "\n"
	}
	if !strings.Contains(joined, "Forgetting snapshot abcdef12") {
		t.Fatalf("missing intro line in:\n%s", joined)
	}
	// Exactly `forget <id>` — forget must never imply --prune.
	if !strings.Contains(joined, "ARGS: forget abcdef12") {
		t.Fatalf("unexpected restic args in:\n%s", joined)
	}
}

func TestForgetSnapshotRejectsInvalidID(t *testing.T) {
	runner, _, _, repoID := setup(t, "/bin/true")
	for _, id := range []string{"", "--prune", "latest", "abcdef12; rm -rf /", "short"} {
		if _, err := runner.EnqueueForgetSnapshot(context.Background(), repoID, id); err == nil {
			t.Errorf("id %q: expected error", id)
		}
	}
	// No operation rows may have been created.
	list, err := runner.ListOperations(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 0 {
		t.Fatalf("expected no operations, got %d", len(list))
	}
}

func TestPruneSuccess(t *testing.T) {
	runner, _, _, repoID := setup(t, stubRestic(t, 0))
	op, err := runner.EnqueuePrune(context.Background(), repoID)
	if err != nil {
		t.Fatal(err)
	}
	if op.Type != "prune" {
		t.Fatalf("type = %q, want prune", op.Type)
	}
	final := waitForStatus(t, runner, op.ID)
	if final.Status != "success" {
		t.Fatalf("status = %q, want success", final.Status)
	}
	logs, _ := runner.GetLogs(context.Background(), op.ID)
	joined := ""
	for _, l := range logs {
		joined += l.Message + "\n"
	}
	if !strings.Contains(joined, "ARGS: prune") {
		t.Fatalf("unexpected restic args in:\n%s", joined)
	}
}

func TestResumeInterrupted(t *testing.T) {
	runner, _, _, _ := setup(t, "/bin/true")
	// Simulate an op left running by a crashed process.
	_, err := runner.st.DB.Exec(`
		INSERT INTO operations (type, status, created_at) VALUES ('backup', 'running', ?)`,
		time.Now().UTC().Format(time.RFC3339))
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.ResumeInterrupted(context.Background()); err != nil {
		t.Fatal(err)
	}
	list, err := runner.ListOperations(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	for _, op := range list {
		if op.Status == "running" || op.Status == "queued" {
			t.Fatalf("op %d still %s after ResumeInterrupted", op.ID, op.Status)
		}
	}
}
