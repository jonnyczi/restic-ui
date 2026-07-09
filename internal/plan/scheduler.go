package plan

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/robfig/cron/v3"
)

// Scheduler fires backup runs for enabled plans on their cron schedules.
// It never auto-runs missed schedules on boot — overdue plans are surfaced in
// the UI instead.
type Scheduler struct {
	svc *Service
	// run enqueues a backup for a plan id (wired to ops.Runner).
	run func(planID int64)

	mu      sync.Mutex
	cron    *cron.Cron
	entries map[int64]cron.EntryID
}

// NewScheduler constructs a Scheduler. Call Reload to (re)register plans and
// Start to begin firing.
func NewScheduler(svc *Service, run func(planID int64)) *Scheduler {
	return &Scheduler{
		svc:     svc,
		run:     run,
		cron:    cron.New(), // minute-precision, local time (TZ env in container)
		entries: make(map[int64]cron.EntryID),
	}
}

// Start begins the scheduler loop.
func (s *Scheduler) Start() { s.cron.Start() }

// Stop halts scheduling; running jobs are unaffected.
func (s *Scheduler) Stop() { s.cron.Stop() }

// Reload re-registers all enabled scheduled plans. Call after any plan change.
func (s *Scheduler) Reload(ctx context.Context) error {
	plans, err := s.svc.ListScheduled(ctx)
	if err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	for _, id := range s.entries {
		s.cron.Remove(id)
	}
	s.entries = make(map[int64]cron.EntryID)

	for _, p := range plans {
		planID := p.ID
		entryID, err := s.cron.AddFunc(p.ScheduleCron, func() {
			slog.Info("schedule fired", "plan", planID)
			s.run(planID)
		})
		if err != nil {
			// Validation should prevent this; log and skip rather than fail all.
			slog.Error("register schedule", "plan", p.ID, "cron", p.ScheduleCron, "err", err)
			continue
		}
		s.entries[p.ID] = entryID
	}
	slog.Info("scheduler reloaded", "scheduled_plans", len(s.entries))
	return nil
}

// NextRuns returns the next fire time per scheduled plan id.
func (s *Scheduler) NextRuns() map[int64]time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[int64]time.Time, len(s.entries))
	for planID, entryID := range s.entries {
		e := s.cron.Entry(entryID)
		if !e.Next.IsZero() {
			out[planID] = e.Next
		}
	}
	return out
}
