// Package api wires up the HTTP surface: JSON endpoints under /api and the
// embedded single-page app for everything else.
package api

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/jonnyczi/restic-ui/internal/auth"
	"github.com/jonnyczi/restic-ui/internal/config"
	"github.com/jonnyczi/restic-ui/internal/crypto"
	"github.com/jonnyczi/restic-ui/internal/notify"
	"github.com/jonnyczi/restic-ui/internal/ops"
	"github.com/jonnyczi/restic-ui/internal/plan"
	"github.com/jonnyczi/restic-ui/internal/repo"
	"github.com/jonnyczi/restic-ui/internal/restic"
	"github.com/jonnyczi/restic-ui/internal/store"
)

// Version is the build version, overridden via -ldflags at build time.
var Version = "dev"

// Server holds shared dependencies for HTTP handlers.
type Server struct {
	store     *store.Store
	cfg       *config.Config
	auth      *auth.Service
	repos     *repo.Service
	plans     *plan.Service
	restic    *restic.Runner
	hub       *ops.Hub
	ops       *ops.Runner
	scheduler *plan.Scheduler
	notify    *notify.Service
}

// NewServer constructs a Server with all services wired.
func NewServer(st *store.Store, cfg *config.Config, box *crypto.Box) *Server {
	s := &Server{
		store:  st,
		cfg:    cfg,
		auth:   auth.NewService(st),
		repos:  repo.NewService(st, box, cfg.DataDir),
		plans:  plan.NewService(st),
		restic: &restic.Runner{Bin: cfg.ResticBinary},
		hub:    ops.NewHub(),
		notify: notify.NewService(st),
	}
	s.ops = ops.NewRunner(st, s.repos, s.plans, s.restic, s.hub)
	s.ops.SetNotifier(s.notify)
	s.scheduler = plan.NewScheduler(s.plans, func(planID int64) {
		if _, err := s.ops.EnqueueBackup(context.Background(), planID); err != nil {
			slog.Error("scheduled backup enqueue", "plan", planID, "err", err)
		}
	})
	return s
}

// Start brings up background machinery: marks operations interrupted by a
// previous process, registers schedules, and starts the cron loop.
func (s *Server) Start(ctx context.Context) error {
	if err := s.ops.ResumeInterrupted(ctx); err != nil {
		return err
	}
	if err := s.scheduler.Reload(ctx); err != nil {
		return err
	}
	s.scheduler.Start()
	return nil
}

// Stop halts the scheduler.
func (s *Server) Stop() { s.scheduler.Stop() }

// Router builds the top-level HTTP handler. The provided spa handler serves the
// embedded frontend for any non-/api route.
func (s *Server) Router(spa http.Handler) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)

	r.Mount("/api", s.apiRouter())

	// Everything else is the SPA (with client-side routing fallback).
	r.Handle("/*", spa)
	return r
}

func (s *Server) apiRouter() http.Handler {
	r := chi.NewRouter()
	r.Use(auth.Middleware(s.auth, s.cfg))

	// Public endpoints.
	r.Get("/healthz", s.handleHealthz)
	r.Get("/auth/me", s.handleAuthMe)
	r.Post("/auth/setup", s.handleAuthSetup)
	r.Post("/auth/login", s.handleAuthLogin)
	r.Post("/auth/logout", s.handleAuthLogout)

	// Everything else requires a session (or bypass identity) + CSRF.
	r.Group(func(r chi.Router) {
		r.Use(auth.RequireAuth)
		s.repoRoutes(r)
		s.planRoutes(r)
		s.opsRoutes(r)
		s.snapRoutes(r)
		s.settingsRoutes(r)
	})

	return r
}
