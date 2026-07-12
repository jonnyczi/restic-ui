// Command restic-ui runs the web UI and API server for managing restic backups.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jonnyczi/restic-ui/internal/api"
	"github.com/jonnyczi/restic-ui/internal/config"
	"github.com/jonnyczi/restic-ui/internal/crypto"
	"github.com/jonnyczi/restic-ui/internal/store"
	"github.com/jonnyczi/restic-ui/web"
)

func main() {
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))

	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	if err := os.MkdirAll(cfg.DataDir, 0o750); err != nil {
		return fmt.Errorf("create data dir %q: %w", cfg.DataDir, err)
	}
	if err := os.MkdirAll(cfg.CacheDir, 0o700); err != nil {
		return fmt.Errorf("create cache dir %q: %w", cfg.CacheDir, err)
	}

	st, err := store.Open(cfg.DataDir)
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer st.Close()
	slog.Info("database ready", "data_dir", cfg.DataDir)

	masterKey, err := crypto.LoadOrCreateKey(cfg.MasterKey, cfg.DataDir)
	if err != nil {
		return fmt.Errorf("master key: %w", err)
	}
	box, err := crypto.NewBox(masterKey)
	if err != nil {
		return fmt.Errorf("init secret box: %w", err)
	}

	spa, err := web.Handler()
	if err != nil {
		return fmt.Errorf("init web handler: %w", err)
	}

	srv := api.NewServer(st, cfg, box)
	if err := srv.Start(context.Background()); err != nil {
		return fmt.Errorf("start services: %w", err)
	}
	defer srv.Stop()

	httpServer := &http.Server{
		Addr:              ":" + strconv.Itoa(cfg.Port),
		Handler:           srv.Router(spa),
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		slog.Info("listening", "addr", httpServer.Addr, "version", api.Version)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("http server error", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	slog.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return httpServer.Shutdown(shutdownCtx)
}
