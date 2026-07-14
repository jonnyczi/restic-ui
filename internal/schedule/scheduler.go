// Package schedule runs cron jobs for entities identified by an int64 id —
// backup plans and repository integrity checks each get their own instance.
// Missed schedules are never auto-run on boot; overdue work is surfaced in
// the UI instead.
package schedule

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/robfig/cron/v3"
)

// parser accepts standard 5-field cron expressions.
var parser = cron.NewParser(
	cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow,
)

// Parse validates a 5-field cron expression.
func Parse(expr string) (cron.Schedule, error) {
	return parser.Parse(expr)
}

// Item is one scheduled entity: its id and cron spec.
type Item struct {
	ID   int64
	Spec string
}

// Scheduler fires run(id) for each loaded item on its cron schedule.
type Scheduler struct {
	// load returns the current set of scheduled items (called on Reload).
	load func(ctx context.Context) ([]Item, error)
	// run executes one item's job (wired to ops.Runner).
	run func(id int64)
	// kind names the entity in logs ("plan", "repo check").
	kind string

	mu      sync.Mutex
	cron    *cron.Cron
	entries map[int64]cron.EntryID
}

// New constructs a Scheduler. Call Reload to (re)register items and Start to
// begin firing.
func New(kind string, load func(ctx context.Context) ([]Item, error), run func(id int64)) *Scheduler {
	return &Scheduler{
		kind:    kind,
		load:    load,
		run:     run,
		cron:    cron.New(), // minute-precision, local time (TZ env in container)
		entries: make(map[int64]cron.EntryID),
	}
}

// Start begins the scheduler loop.
func (s *Scheduler) Start() { s.cron.Start() }

// Stop halts scheduling; running jobs are unaffected.
func (s *Scheduler) Stop() { s.cron.Stop() }

// Reload re-registers all scheduled items. Call after any mutation.
func (s *Scheduler) Reload(ctx context.Context) error {
	items, err := s.load(ctx)
	if err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	for _, id := range s.entries {
		s.cron.Remove(id)
	}
	s.entries = make(map[int64]cron.EntryID)

	for _, it := range items {
		id := it.ID
		entryID, err := s.cron.AddFunc(it.Spec, func() {
			slog.Info("schedule fired", "kind", s.kind, "id", id)
			s.run(id)
		})
		if err != nil {
			// Validation should prevent this; log and skip rather than fail all.
			slog.Error("register schedule", "kind", s.kind, "id", it.ID, "cron", it.Spec, "err", err)
			continue
		}
		s.entries[it.ID] = entryID
	}
	slog.Info("scheduler reloaded", "kind", s.kind, "scheduled", len(s.entries))
	return nil
}

// NextRuns returns the next fire time per scheduled item id.
func (s *Scheduler) NextRuns() map[int64]time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[int64]time.Time, len(s.entries))
	for id, entryID := range s.entries {
		e := s.cron.Entry(entryID)
		if !e.Next.IsZero() {
			out[id] = e.Next
		}
	}
	return out
}
