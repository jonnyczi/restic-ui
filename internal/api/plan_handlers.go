package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/jonnyczi/restic-ui/internal/plan"
)

// retentionTimeout bounds the synchronous forget --dry-run preview call.
const retentionTimeout = 2 * time.Minute

func (s *Server) planRoutes(r chi.Router) {
	r.Route("/plans", func(r chi.Router) {
		r.Get("/", s.handlePlanList)
		r.Post("/", s.handlePlanCreate)
		r.Post("/retention-preview", s.handleRetentionPreview)
		r.Route("/{id}", func(r chi.Router) {
			r.Get("/", s.handlePlanGet)
			r.Put("/", s.handlePlanUpdate)
			r.Delete("/", s.handlePlanDelete)
			r.Post("/run", s.handlePlanRun)
			r.Post("/forget", s.handlePlanForget)
			r.Post("/enabled", s.handlePlanSetEnabled)
		})
	})
}

func planID(r *http.Request) (int64, error) {
	return strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
}

func writePlanError(w http.ResponseWriter, err error) {
	if errors.Is(err, plan.ErrNotFound) {
		writeError(w, http.StatusNotFound, "plan not found")
		return
	}
	writeError(w, http.StatusBadRequest, err.Error())
}

// planView decorates a Plan with its next scheduled run.
type planView struct {
	plan.Plan
	NextRun *string `json:"nextRun,omitempty"`
}

func (s *Server) decoratePlans(plans []plan.Plan) []planView {
	next := s.scheduler.NextRuns()
	out := make([]planView, len(plans))
	for i, p := range plans {
		out[i] = planView{Plan: p}
		if t, ok := next[p.ID]; ok {
			ts := t.Format(time.RFC3339)
			out[i].NextRun = &ts
		}
	}
	return out
}

func (s *Server) handlePlanList(w http.ResponseWriter, r *http.Request) {
	plans, err := s.plans.List(r.Context())
	if err != nil {
		slog.Error("list plans", "err", err)
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, s.decoratePlans(plans))
}

func (s *Server) handlePlanGet(w http.ResponseWriter, r *http.Request) {
	id, err := planID(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	p, err := s.plans.Get(r.Context(), id)
	if err != nil {
		writePlanError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.decoratePlans([]plan.Plan{*p})[0])
}

func (s *Server) handlePlanCreate(w http.ResponseWriter, r *http.Request) {
	var in plan.Input
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	created, err := s.plans.Create(r.Context(), in)
	if err != nil {
		writePlanError(w, err)
		return
	}
	if err := s.scheduler.Reload(r.Context()); err != nil {
		slog.Error("scheduler reload", "err", err)
	}
	slog.Info("plan created", "id", created.ID, "name", created.Name)
	writeJSON(w, http.StatusCreated, s.decoratePlans([]plan.Plan{*created})[0])
}

func (s *Server) handlePlanUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := planID(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var in plan.Input
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	updated, err := s.plans.Update(r.Context(), id, in)
	if err != nil {
		writePlanError(w, err)
		return
	}
	if err := s.scheduler.Reload(r.Context()); err != nil {
		slog.Error("scheduler reload", "err", err)
	}
	writeJSON(w, http.StatusOK, s.decoratePlans([]plan.Plan{*updated})[0])
}

func (s *Server) handlePlanDelete(w http.ResponseWriter, r *http.Request) {
	id, err := planID(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	if err := s.plans.Delete(r.Context(), id); err != nil {
		writePlanError(w, err)
		return
	}
	if err := s.scheduler.Reload(r.Context()); err != nil {
		slog.Error("scheduler reload", "err", err)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handlePlanSetEnabled(w http.ResponseWriter, r *http.Request) {
	id, err := planID(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var body struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := s.plans.SetEnabled(r.Context(), id, body.Enabled); err != nil {
		writePlanError(w, err)
		return
	}
	if err := s.scheduler.Reload(r.Context()); err != nil {
		slog.Error("scheduler reload", "err", err)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handlePlanRun(w http.ResponseWriter, r *http.Request) {
	id, err := planID(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	op, err := s.ops.EnqueueBackup(r.Context(), id)
	if err != nil {
		writePlanError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, op)
}

// handleRetentionPreview reports which snapshots a retention policy would
// keep or remove, without applying it. Takes the policy directly in the body
// (rather than a saved plan id) so it works for plans still being edited.
func (s *Server) handleRetentionPreview(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RepoID    int64          `json:"repoId"`
		Sources   []string       `json:"sources"`
		Retention plan.Retention `json:"retention"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if body.Retention.Empty() {
		writeError(w, http.StatusBadRequest, "no retention policy configured")
		return
	}
	_, rc, err := s.repos.BuildRepoConfig(r.Context(), body.RepoID)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	args := body.Retention.Args()
	for _, src := range body.Sources {
		args = append(args, "--path", src)
	}
	ctx, cancel := context.WithTimeout(r.Context(), retentionTimeout)
	defer cancel()
	groups, err := s.restic.ForgetDryRun(ctx, rc, args)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, groups)
}

// handlePlanForget applies the plan's retention policy immediately.
func (s *Server) handlePlanForget(w http.ResponseWriter, r *http.Request) {
	id, err := planID(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	op, err := s.ops.EnqueueForget(r.Context(), id)
	if err != nil {
		writePlanError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, op)
}
