package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/jonnyczi/restic-ui/internal/notify"
	opsvc "github.com/jonnyczi/restic-ui/internal/ops"
)

func (s *Server) settingsRoutes(r chi.Router) {
	r.Get("/settings", s.handleSettingsGet)
	r.Put("/settings", s.handleSettingsPut)
	r.Post("/notifications/test", s.handleNotifyTest)
	r.Get("/dashboard", s.handleDashboard)
}

func (s *Server) handleSettingsGet(w http.ResponseWriter, r *http.Request) {
	cfg, err := s.notify.Get(r.Context())
	if err != nil {
		slog.Error("get settings", "err", err)
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, cfg)
}

func (s *Server) handleSettingsPut(w http.ResponseWriter, r *http.Request) {
	var in notify.Settings
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := s.notify.Save(r.Context(), in); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	cfg, _ := s.notify.Get(r.Context())
	writeJSON(w, http.StatusOK, cfg)
}

func (s *Server) handleNotifyTest(w http.ResponseWriter, r *http.Request) {
	err := s.notify.Send(r.Context(),
		"restic-ui: test notification",
		"If you can read this, notifications are working.",
		"info")
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// dashboardPlan is one plan's status line on the dashboard.
type dashboardPlan struct {
	ID           int64   `json:"id"`
	Name         string  `json:"name"`
	RepoName     string  `json:"repoName"`
	ScheduleCron string  `json:"scheduleCron"`
	Enabled      bool    `json:"enabled"`
	NextRun      *string `json:"nextRun,omitempty"`
	LastStatus   *string `json:"lastStatus,omitempty"`
	LastRun      *string `json:"lastRun,omitempty"`
	// Overdue: scheduled, enabled, but the last successful backup is older
	// than two schedule intervals (or never ran).
	Overdue bool `json:"overdue"`
}

// growthPoint is one repo-size measurement for the dashboard sparklines.
type growthPoint struct {
	T    string `json:"t"`
	Size int64  `json:"size"`
}

// repoGrowth is one repository's recent size history.
type repoGrowth struct {
	RepoID   int64         `json:"repoId"`
	RepoName string        `json:"repoName"`
	Points   []growthPoint `json:"points"`
}

// durationPoint is one completed backup's wall-clock duration.
type durationPoint struct {
	T       string  `json:"t"`
	Seconds float64 `json:"seconds"`
}

type dashboardResponse struct {
	RepoCount     int                       `json:"repoCount"`
	PlanCount     int                       `json:"planCount"`
	RunningOps    int                       `json:"runningOps"`
	Issues24h     int                       `json:"issues24h"`
	Plans         []dashboardPlan           `json:"plans"`
	RecentOps     []any                     `json:"recentOps"`
	RepoGrowth    []repoGrowth              `json:"repoGrowth"`
	PlanDurations map[int64][]durationPoint `json:"planDurations"`
}

func (s *Server) handleDashboard(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	resp := dashboardResponse{Plans: []dashboardPlan{}, RecentOps: []any{}}

	row := s.store.DB.QueryRowContext(ctx, `SELECT
		(SELECT COUNT(*) FROM repos),
		(SELECT COUNT(*) FROM plans),
		(SELECT COUNT(*) FROM operations WHERE status IN ('running','queued')),
		(SELECT COUNT(*) FROM operations WHERE status IN ('error','warning') AND ended_at > datetime('now','-1 day'))`)
	if err := row.Scan(&resp.RepoCount, &resp.PlanCount, &resp.RunningOps, &resp.Issues24h); err != nil {
		slog.Error("dashboard counts", "err", err)
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	plans, err := s.plans.List(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	next := s.scheduler.NextRuns()
	for _, p := range plans {
		dp := dashboardPlan{
			ID: p.ID, Name: p.Name, RepoName: p.RepoName,
			ScheduleCron: p.ScheduleCron, Enabled: p.Enabled,
		}
		if t, ok := next[p.ID]; ok {
			ts := t.Format("2006-01-02T15:04:05Z07:00")
			dp.NextRun = &ts
		}
		var status, ended string
		err := s.store.DB.QueryRowContext(ctx, `
			SELECT status, COALESCE(ended_at,'') FROM operations
			WHERE plan_id=? AND type='backup' ORDER BY id DESC LIMIT 1`, p.ID,
		).Scan(&status, &ended)
		if err == nil {
			dp.LastStatus = &status
			if ended != "" {
				dp.LastRun = &ended
			}
		}
		// Overdue: enabled + scheduled + no successful backup within 2 intervals.
		if p.Enabled && p.ScheduleCron != "" {
			var okCount int
			_ = s.store.DB.QueryRowContext(ctx, `
				SELECT COUNT(*) FROM operations
				WHERE plan_id=? AND type='backup' AND status IN ('success','warning')
				  AND ended_at > datetime('now', ?)`,
				p.ID, "-"+intervalHint(p.ScheduleCron)).Scan(&okCount)
			dp.Overdue = okCount == 0
		}
		resp.Plans = append(resp.Plans, dp)
	}

	ops, err := s.ops.ListOperations(ctx, opsvc.OpFilter{Limit: 10})
	if err == nil {
		for _, op := range ops {
			resp.RecentOps = append(resp.RecentOps, op)
		}
	}

	resp.RepoGrowth = []repoGrowth{}
	if repos, err := s.repos.List(ctx); err == nil {
		for _, rp := range repos {
			points, err := s.repos.StatsHistory(ctx, rp.ID, 30)
			if err != nil || len(points) == 0 {
				continue
			}
			g := repoGrowth{RepoID: rp.ID, RepoName: rp.Name, Points: make([]growthPoint, len(points))}
			for i, p := range points {
				g.Points[i] = growthPoint{T: p.CapturedAt, Size: p.TotalSize}
			}
			resp.RepoGrowth = append(resp.RepoGrowth, g)
		}
	}

	resp.PlanDurations = map[int64][]durationPoint{}
	rows, err := s.store.DB.QueryContext(ctx, `
		SELECT plan_id, started_at, ended_at FROM operations
		WHERE type='backup' AND status IN ('success','warning')
		  AND plan_id IS NOT NULL AND started_at IS NOT NULL AND ended_at IS NOT NULL
		ORDER BY id DESC LIMIT 300`)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var planID int64
			var started, ended string
			if rows.Scan(&planID, &started, &ended) != nil {
				continue
			}
			st, err1 := time.Parse(time.RFC3339, started)
			en, err2 := time.Parse(time.RFC3339, ended)
			if err1 != nil || err2 != nil || len(resp.PlanDurations[planID]) >= 20 {
				continue
			}
			resp.PlanDurations[planID] = append(resp.PlanDurations[planID],
				durationPoint{T: ended, Seconds: en.Sub(st).Seconds()})
		}
		// Rows arrive newest-first; reverse each series to ascending time.
		for id, pts := range resp.PlanDurations {
			for i, j := 0, len(pts)-1; i < j; i, j = i+1, j-1 {
				pts[i], pts[j] = pts[j], pts[i]
			}
			resp.PlanDurations[id] = pts
		}
	}

	writeJSON(w, http.StatusOK, resp)
}

// intervalHint maps a cron expression to a SQLite datetime offset covering
// roughly two firing intervals — a pragmatic overdue heuristic.
func intervalHint(cron string) string {
	switch {
	case len(cron) >= 3 && cron[0:2] == "* ":
		return "2 minutes"
	case cron == "0 * * * *":
		return "2 hours"
	default:
		// daily-ish and everything else: two days grace
		return "2 days"
	}
}
