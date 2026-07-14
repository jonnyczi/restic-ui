package schedule

import (
	"context"
	"testing"
)

func TestParse(t *testing.T) {
	if _, err := Parse("0 2 * * *"); err != nil {
		t.Fatalf("valid 5-field cron rejected: %v", err)
	}
	if _, err := Parse("0 0 2 * * *"); err == nil {
		t.Fatal("6-field cron accepted, want error")
	}
	if _, err := Parse("nonsense"); err == nil {
		t.Fatal("garbage accepted, want error")
	}
}

func TestReloadRegistersAndRemoves(t *testing.T) {
	items := []Item{{ID: 1, Spec: "0 2 * * *"}, {ID: 2, Spec: "0 3 * * 0"}}
	s := New("test", func(context.Context) ([]Item, error) { return items, nil }, func(int64) {})
	s.Start() // Next fire times are only computed by a running cron.
	defer s.Stop()

	if err := s.Reload(context.Background()); err != nil {
		t.Fatal(err)
	}
	next := s.NextRuns()
	if len(next) != 2 {
		t.Fatalf("NextRuns entries = %d, want 2", len(next))
	}
	if next[1].IsZero() || next[2].IsZero() {
		t.Fatal("next fire times missing")
	}

	// Shrinking the item set removes stale entries.
	items = items[:1]
	if err := s.Reload(context.Background()); err != nil {
		t.Fatal(err)
	}
	if next := s.NextRuns(); len(next) != 1 {
		t.Fatalf("NextRuns entries after shrink = %d, want 1", len(next))
	}
}

func TestReloadSkipsInvalidSpecWithoutFailing(t *testing.T) {
	items := []Item{{ID: 1, Spec: "not a cron"}, {ID: 2, Spec: "* * * * *"}}
	s := New("test", func(context.Context) ([]Item, error) { return items, nil }, func(int64) {})
	s.Start()
	defer s.Stop()

	if err := s.Reload(context.Background()); err != nil {
		t.Fatalf("Reload failed on one bad spec: %v", err)
	}
	next := s.NextRuns()
	if len(next) != 1 {
		t.Fatalf("NextRuns entries = %d, want 1 (bad spec skipped)", len(next))
	}
	if _, ok := next[2]; !ok {
		t.Fatal("valid item missing from NextRuns")
	}
}
