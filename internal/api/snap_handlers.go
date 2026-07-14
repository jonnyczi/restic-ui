package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

// snapIDParam matches restic snapshot ids (short or full hex) — same rule as
// the ops runner enforces; anything else never reaches restic argv.
var snapIDParam = regexp.MustCompile(`^[0-9a-fA-F]{8,64}$`)

func (s *Server) snapRoutes(r chi.Router) {
	r.Get("/repos/{id}/snapshots/{snap}/ls", s.handleSnapLs)
	r.Get("/repos/{id}/snapshots/{snap}/dump", s.handleSnapDump)
	r.Post("/repos/{id}/snapshots/{snap}/forget", s.handleSnapForget)
	r.Get("/repos/{id}/diff", s.handleRepoDiff)
	r.Get("/repos/{id}/find", s.handleRepoFind)
	r.Post("/repos/{id}/restore", s.handleRepoRestore)
	r.Post("/repos/{id}/copy", s.handleRepoCopy)
}

// handleRepoDiff compares two snapshots (?from=&to=).
func (s *Server) handleRepoDiff(w http.ResponseWriter, r *http.Request) {
	from, to := r.URL.Query().Get("from"), r.URL.Query().Get("to")
	if !snapIDParam.MatchString(from) || !snapIDParam.MatchString(to) {
		writeError(w, http.StatusBadRequest, "from and to must be snapshot ids")
		return
	}
	_, rc, ok := s.withRepoConfig(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), repoTimeout)
	defer cancel()
	res, err := s.restic.Diff(ctx, rc, from, to)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// handleRepoFind searches all snapshots for a filename pattern (?pattern=).
func (s *Server) handleRepoFind(w http.ResponseWriter, r *http.Request) {
	pattern := strings.TrimSpace(r.URL.Query().Get("pattern"))
	if pattern == "" || strings.HasPrefix(pattern, "-") {
		writeError(w, http.StatusBadRequest, "a search pattern is required")
		return
	}
	_, rc, ok := s.withRepoConfig(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), repoTimeout)
	defer cancel()
	res, err := s.restic.Find(ctx, rc, pattern)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleSnapForget(w http.ResponseWriter, r *http.Request) {
	id, err := repoID(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	op, err := s.ops.EnqueueForgetSnapshot(r.Context(), id, chi.URLParam(r, "snap"))
	if err != nil {
		writeRepoError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, op)
}

func (s *Server) handleSnapLs(w http.ResponseWriter, r *http.Request) {
	_, rc, ok := s.withRepoConfig(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), repoTimeout)
	defer cancel()
	nodes, err := s.restic.Ls(ctx, rc, chi.URLParam(r, "snap"), r.URL.Query().Get("path"))
	if err != nil {
		writeRepoError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, nodes)
}

// handleSnapDump streams a file (raw) or folder (tar) from a snapshot as a
// download without any FUSE mount.
func (s *Server) handleSnapDump(w http.ResponseWriter, r *http.Request) {
	_, rc, ok := s.withRepoConfig(w, r)
	if !ok {
		return
	}
	p := r.URL.Query().Get("path")
	if p == "" {
		writeError(w, http.StatusBadRequest, "path is required")
		return
	}
	isDir := r.URL.Query().Get("dir") == "1"

	filename := path.Base(p)
	if filename == "/" || filename == "." {
		filename = "snapshot"
	}
	if isDir {
		filename += ".tar"
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	defer cancel()
	cmd := s.restic.DumpCommand(ctx, rc, chi.URLParam(r, "snap"), p)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start restic")
		return
	}
	if err := cmd.Start(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start restic")
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	// Headers are committed once bytes flow; a mid-stream restic failure
	// truncates the download (detected client-side by the tar/file consumer).
	if _, err := io.Copy(w, stdout); err != nil {
		slog.Warn("dump stream interrupted", "err", err)
	}
	if err := cmd.Wait(); err != nil {
		slog.Warn("restic dump failed", "err", err)
	}
}

func (s *Server) handleRepoRestore(w http.ResponseWriter, r *http.Request) {
	id, err := repoID(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var body struct {
		SnapshotID  string `json:"snapshotId"`
		IncludePath string `json:"includePath"`
		Target      string `json:"target"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	op, err := s.ops.EnqueueRestore(r.Context(), id, body.SnapshotID, body.IncludePath, body.Target)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, op)
}

func (s *Server) handleRepoCopy(w http.ResponseWriter, r *http.Request) {
	id, err := repoID(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var body struct {
		DestRepoID  int64    `json:"destRepoId"`
		SnapshotIDs []string `json:"snapshotIds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	op, err := s.ops.EnqueueCopy(r.Context(), id, body.DestRepoID, body.SnapshotIDs)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, op)
}
