# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A web UI + Go backend for configuring and running [restic](https://restic.net) backups, aimed at homelab/Unraid users, shipped as a single Docker container. Go serves a JSON API and embeds the built React SPA in one static binary.

## Commands

```sh
make run          # backend on :8080 (serves whatever is in web/dist)
make dev          # Vite dev server with HMR; proxies /api (+ websockets) to :8080 — run alongside `make run`
make build        # pnpm build + go build -> bin/restic-ui (SPA embedded)
make test         # go test ./...
make e2e          # Playwright suite against a dockerized environment (see below)
make docker       # build the image for the current arch
make docker-multiarch  # amd64 + arm64 via buildx

go test ./internal/ops/ -run TestBackupSuccess   # single Go test
cd web && pnpm typecheck                         # frontend type check
cd e2e && npx playwright test tests/plans.spec.ts  # single e2e spec
```

E2E notes: specs each reset a disposable compose environment (app on :8199 + MinIO + a fake Apprise server) via `e2e/reset-env.sh`. Set `CHROMIUM_BIN=/path/to/chromium` to use a system browser (needed on NixOS, where Playwright's downloaded browser won't run). Specs run serially (`workers: 1`); every `docker compose` invocation must carry the same `PUID`/`PGID` (helpers.ts does this) — a mismatched `compose up` recreates the app container under a different uid and leaves `/config` files the runner can't delete.

## Architecture

**How restic is driven.** There is no restic library — `internal/restic` shells out to a bundled, pinned `restic` binary and parses `--json` output. The repository location and password travel via environment variables (`RESTIC_REPOSITORY`, `RESTIC_PASSWORD`), never argv (visible in `ps`). restic exit codes are mapped to friendly errors (10 = not initialized, 11 = locked, 12 = wrong password); backup exit code 3 becomes a `warning` status (snapshot created, some files unreadable).

**Repository backends** (`internal/repo`) build per-backend location strings: local path, `s3:http(s)://host/bucket[/prefix]`, `sftp://user@host:port/` + path (one leading `/` = relative to login home, `//` = absolute), `rclone:remote:path`. Secret material (repo password, S3 secret key, SSH private key, rclone.conf) is AES-256-GCM encrypted in SQLite (`internal/crypto`); the master key comes from `RESTIC_UI_KEY`(`_FILE`) or is generated into `DATA_DIR/secret.key`. SSH keys and rclone configs are materialized to 0600 files under `DATA_DIR/creds/` at invocation time. Update semantics: empty password/secret fields on PUT mean "keep existing".

**Long-running operations** (`internal/ops`) are serialized per-repository with a mutex map — never two restic processes on one repo. Backups stream `backup --json` line-by-line: `status` messages are throttled (~2/s) and broadcast only; the `summary` message is persisted to `operations.summary_json`; logs go to `operation_logs` and are simultaneously fanned out through `ops.Hub` (a drop-on-slow pub/sub). Other commands (forget/prune, restore, copy, check) run through the generic `runCommand` path that logs every output line. A plan with a retention policy auto-chains a `retention` operation after each successful backup — enqueued *after* the backup releases the repo lock (enqueueing while holding it would deadlock). `ResumeInterrupted` marks stale running/queued ops as errored at boot; missed schedules are never auto-run.

**Copy between repos** uses `RESTIC_FROM_REPOSITORY`/`RESTIC_FROM_PASSWORD` with the destination as the primary repo; both repos' backend envs are merged, so two repos on the same cloud provider with *different* credentials can't be copied between (restic env model limitation).

**Live updates.** One WebSocket (`/api/stream`, coder/websocket) carries `op` / `log` / `progress` events. The frontend (`web/src/hooks/useOperations.ts`) folds these directly into the TanStack Query cache — operation status flips live with no polling; completion also invalidates snapshots/stats/plans queries.

**Auth** (`internal/auth`): single user, bcrypt, sessions persisted in SQLite as SHA-256 hashes of the cookie token. Public routes are only `/api/healthz` and `/api/auth/*`; everything else sits behind `RequireAuth`, which also enforces a per-session CSRF token (`X-CSRF-Token` header, delivered by `/api/auth/me`) on non-GET methods. Bypass modes: `AUTH_DISABLED` or `TRUSTED_PROXY_HEADER` (reverse-proxy SSO); in bypass, the CSRF header must still be present (any value).

**Scheduling** (`internal/plan/scheduler.go`): robfig/cron with standard 5-field expressions. `Reload()` must be called after any plan mutation (the API handlers do this); `NextRuns()` decorates plan API responses.

**Persistence**: SQLite via pure-Go `modernc.org/sqlite` (no CGO anywhere — keep it that way for the static binary), WAL mode, `SetMaxOpenConns(1)`. Migrations are goose SQL files embedded from `internal/store/migrations/` and run at startup; add new ones as `000N_name.sql`.

**Frontend**: React 19 + TS + Tailwind v4 + hand-rolled shadcn-style primitives in `web/src/components/ui/` (no Radix). `web/embed.go` embeds `web/dist` via `go:embed` with SPA fallback. The committed `web/dist/index.html` is a placeholder so `go build` works without a frontend build — don't commit built assets over it (the Docker build injects the real SPA). pnpm 11: build-script allowlist lives in `web/pnpm-workspace.yaml` (`allowBuilds`), not package.json.

**Container**: multi-stage Dockerfile; stages 1–3 are pinned to `$BUILDPLATFORM` with `GOARCH` cross-compilation so multi-arch builds don't emulate toolchains; restic/rclone downloads are verified against their published SHA256SUMS. The entrypoint reconciles a runtime user with `PUID`/`PGID` (LinuxServer.io convention) and drops privileges via su-exec.

## Conventions

- Notifications go through an external **Apprise API** server (settings point at it) — do not bundle apprise/Python into the image.
- Snapshot browsing/restoring uses `restic ls`/`dump`/`restore` — **no FUSE**; the container needs no special privileges. Keep it that way.
- API error shape is `{"error": "message"}` via `writeError`; handlers live in `internal/api/*_handlers.go` grouped by feature.
- Verification standard for feature work: unit tests + run the real Docker container and exercise the flow in a browser (the e2e suite is the codified form of this).
