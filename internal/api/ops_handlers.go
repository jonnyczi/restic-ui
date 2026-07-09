package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/go-chi/chi/v5"

	"github.com/jonnyczi/restic-ui/internal/fsbrowse"
	"github.com/jonnyczi/restic-ui/internal/ops"
)

func (s *Server) opsRoutes(r chi.Router) {
	r.Get("/operations", s.handleOpsList)
	r.Get("/operations/{id}", s.handleOpGet)
	r.Get("/operations/{id}/logs", s.handleOpLogs)
	r.Post("/operations/{id}/cancel", s.handleOpCancel)
	r.Get("/fs/browse", s.handleFsBrowse)
	r.Get("/stream", s.handleStream)
}

func (s *Server) handleOpsList(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	list, err := s.ops.ListOperations(r.Context(), limit)
	if err != nil {
		slog.Error("list operations", "err", err)
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleOpGet(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	op, err := s.ops.GetOperation(r.Context(), id)
	if errors.Is(err, ops.ErrNotFound) {
		writeError(w, http.StatusNotFound, "operation not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, op)
}

func (s *Server) handleOpLogs(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	logs, err := s.ops.GetLogs(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, logs)
}

func (s *Server) handleOpCancel(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	if !s.ops.Cancel(id) {
		writeError(w, http.StatusConflict, "operation is not running")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleFsBrowse(w http.ResponseWriter, r *http.Request) {
	listing, err := fsbrowse.Browse(r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, listing)
}

// handleStream upgrades to a WebSocket and forwards hub events until the
// client disconnects. Auth ran in middleware before we get here.
func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, nil) // default: same-origin only
	if err != nil {
		slog.Warn("websocket accept", "err", err)
		return
	}
	defer conn.CloseNow()

	events, cancel := s.hub.Subscribe()
	defer cancel()

	ctx := r.Context()
	// Read loop: we expect no client messages, but reading detects disconnects.
	go func() {
		for {
			if _, _, err := conn.Read(ctx); err != nil {
				return
			}
		}
	}()

	ping := time.NewTicker(30 * time.Second)
	defer ping.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ping.C:
			pctx, pcancel := context.WithTimeout(ctx, 5*time.Second)
			err := conn.Ping(pctx)
			pcancel()
			if err != nil {
				return
			}
		case ev, ok := <-events:
			if !ok {
				return
			}
			wctx, wcancel := context.WithTimeout(ctx, 5*time.Second)
			err := wsjson.Write(wctx, conn, ev)
			wcancel()
			if err != nil {
				return
			}
		}
	}
}
