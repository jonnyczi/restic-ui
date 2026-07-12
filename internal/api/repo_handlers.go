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

	"github.com/jonnyczi/restic-ui/internal/repo"
	"github.com/jonnyczi/restic-ui/internal/restic"
)

// repoTimeout bounds quick repo operations; check gets checkTimeout.
const (
	repoTimeout  = 2 * time.Minute
	checkTimeout = 15 * time.Minute
)

func (s *Server) repoRoutes(r chi.Router) {
	r.Route("/repos", func(r chi.Router) {
		r.Get("/", s.handleRepoList)
		r.Post("/", s.handleRepoCreate)
		r.Route("/{id}", func(r chi.Router) {
			r.Get("/", s.handleRepoGet)
			r.Put("/", s.handleRepoUpdate)
			r.Delete("/", s.handleRepoDelete)
			r.Post("/init", s.handleRepoInit)
			r.Post("/test", s.handleRepoTest)
			r.Post("/check", s.handleRepoCheck)
			r.Post("/unlock", s.handleRepoUnlock)
			r.Post("/prune", s.handleRepoPrune)
			r.Get("/snapshots", s.handleRepoSnapshots)
			r.Get("/stats", s.handleRepoStats)
		})
	})
}

// repoID extracts and parses the {id} URL parameter.
func repoID(r *http.Request) (int64, error) {
	return strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
}

// writeRepoError maps service/restic errors to HTTP responses.
func writeRepoError(w http.ResponseWriter, err error) {
	var resticErr *restic.Error
	switch {
	case errors.Is(err, repo.ErrNotFound):
		writeError(w, http.StatusNotFound, "repository not found")
	case errors.As(err, &resticErr):
		writeError(w, http.StatusBadGateway, resticErr.Friendly())
	default:
		writeError(w, http.StatusBadRequest, err.Error())
	}
}

func (s *Server) handleRepoList(w http.ResponseWriter, r *http.Request) {
	repos, err := s.repos.List(r.Context())
	if err != nil {
		slog.Error("list repos", "err", err)
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, repos)
}

func (s *Server) handleRepoCreate(w http.ResponseWriter, r *http.Request) {
	var in repo.Input
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	created, err := s.repos.Create(r.Context(), in)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	slog.Info("repository created", "id", created.ID, "name", created.Name, "backend", created.BackendType)
	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) handleRepoGet(w http.ResponseWriter, r *http.Request) {
	id, err := repoID(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	rp, err := s.repos.Get(r.Context(), id)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rp)
}

func (s *Server) handleRepoUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := repoID(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var in repo.Input
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	updated, err := s.repos.Update(r.Context(), id, in)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) handleRepoDelete(w http.ResponseWriter, r *http.Request) {
	id, err := repoID(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	if err := s.repos.Delete(r.Context(), id); err != nil {
		writeRepoError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// withRepoConfig resolves the repo and its runnable config, handling errors.
func (s *Server) withRepoConfig(w http.ResponseWriter, r *http.Request) (*repo.Repo, restic.RepoConfig, bool) {
	id, err := repoID(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return nil, restic.RepoConfig{}, false
	}
	rp, rc, err := s.repos.BuildRepoConfig(r.Context(), id)
	if err != nil {
		writeRepoError(w, err)
		return nil, restic.RepoConfig{}, false
	}
	return rp, rc, true
}

func (s *Server) handleRepoInit(w http.ResponseWriter, r *http.Request) {
	rp, rc, ok := s.withRepoConfig(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), repoTimeout)
	defer cancel()
	if err := s.restic.Init(ctx, rc); err != nil {
		writeRepoError(w, err)
		return
	}
	slog.Info("repository initialized", "id", rp.ID, "name", rp.Name)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleRepoTest(w http.ResponseWriter, r *http.Request) {
	_, rc, ok := s.withRepoConfig(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), repoTimeout)
	defer cancel()
	if err := s.restic.CatConfig(ctx, rc); err != nil {
		writeRepoError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleRepoCheck(w http.ResponseWriter, r *http.Request) {
	_, rc, ok := s.withRepoConfig(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), checkTimeout)
	defer cancel()
	report, err := s.restic.Check(ctx, rc)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"report": report})
}

// handleRepoPrune enqueues a background prune (long-running; locks the repo
// for the duration), unlike check which runs synchronously.
func (s *Server) handleRepoPrune(w http.ResponseWriter, r *http.Request) {
	id, err := repoID(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	op, err := s.ops.EnqueuePrune(r.Context(), id)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, op)
}

func (s *Server) handleRepoUnlock(w http.ResponseWriter, r *http.Request) {
	_, rc, ok := s.withRepoConfig(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), repoTimeout)
	defer cancel()
	if err := s.restic.Unlock(ctx, rc); err != nil {
		writeRepoError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleRepoSnapshots(w http.ResponseWriter, r *http.Request) {
	_, rc, ok := s.withRepoConfig(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), repoTimeout)
	defer cancel()
	snaps, err := s.restic.Snapshots(ctx, rc)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snaps)
}

func (s *Server) handleRepoStats(w http.ResponseWriter, r *http.Request) {
	_, rc, ok := s.withRepoConfig(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), repoTimeout)
	defer cancel()
	st, err := s.restic.Stats(ctx, rc)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}
