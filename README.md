# restic-ui

A web UI + backend for configuring and running [restic](https://restic.net)
backups, built for homelab users (Unraid and similar). Ships as a single Docker
container.

> **Status:** v1 feature-complete, pre-release.

## Features

- Manage multiple restic repositories across backends: **local path, S3-compatible,
  SFTP, and rclone** (rclone unlocks ~70 more providers). Credentials are
  **encrypted at rest** (AES-256-GCM).
- Scheduled **backup plans** with an in-UI folder picker, include/exclude
  patterns, tags, cron schedules, and per-plan **retention** (`forget` +
  `prune`, applied automatically after each backup).
- **Browse and restore** individual files or folders from any snapshot — no
  FUSE or special container privileges required (uses `restic ls` / `dump`).
- **Copy/replicate** snapshots to a second repository (3-2-1 backups).
- **Live progress and logs** for running operations over WebSocket.
- Notifications through an **[Apprise API](https://github.com/caronc/apprise-api)
  server** (Discord, Telegram, ntfy, email, and 80+ more) — run the tiny
  `linuxserver/apprise-api` sidecar and point Settings at it.
- Single-user login with optional **reverse-proxy bypass** (Authelia/Authentik).
- _Planned (phase 2):_ host storage for other restic clients (rest-server),
  pre/post hooks, optional FUSE mount, multi-user.

## Quick start

```sh
docker compose up --build
# open http://localhost:8080 and create your admin account
```

Mount the folders you want to back up (read-only is recommended) and a
destination folder for local repositories — see `docker-compose.yml`.
Prebuilt multi-arch images are on Docker Hub as
[`jonnyczi/restic-ui`](https://hub.docker.com/r/jonnyczi/restic-ui).

**Unraid:** a Community Applications template is provided in
`unraid-template.xml`. Until it lands in CA, copy it to
`/boot/config/plugins/dockerMan/templates-user/` on your Unraid box, then
pick *restic-ui* from the template dropdown under Docker → Add Container.

## Architecture

- **Backend:** Go — single static binary; drives the bundled `restic` binary by
  shelling out and parsing `--json`; SQLite (pure-Go) for config + history.
- **Frontend:** React + TypeScript + Vite + Tailwind + shadcn/ui, embedded into
  the Go binary.

## Development

Requirements: Go 1.26+, Node 22+, pnpm.

```sh
# Terminal 1 — backend on :8080
make run

# Terminal 2 — frontend dev server (proxies /api to :8080)
make dev
```

Build the fully embedded binary:

```sh
make build      # -> bin/restic-ui  (frontend built + embedded)
```

Build the container:

```sh
make docker            # -> restic-ui:latest (current arch)
make docker-multiarch  # -> linux/amd64 + linux/arm64 (requires buildx)
# or
docker compose up --build
```

## Testing

```sh
make test    # Go unit tests
make e2e     # browser end-to-end suite (Playwright + Docker)
```

The e2e suite (`e2e/`) spins up a disposable environment —
the app, a MinIO server, and a fake Apprise API — via
`e2e/docker-compose.test.yml`, then drives the real UI in Chromium:
first-run setup, auth/session/CSRF, repository management (local + S3),
plans with the folder picker, live WebSocket operations, cron firing,
retention pruning, snapshot browse/download/restore, copy between repos,
and notifications. Set `CHROMIUM_BIN=/path/to/chromium` to use a system
browser instead of Playwright's download.

CI (GitHub Actions) runs vet/tests, frontend typecheck/build, the e2e
suite, and a multi-arch (amd64 + arm64) image build — pushed to GHCR
and Docker Hub (jonnyczi/restic-ui) on `main` and version tags.

## Configuration (environment)

| Variable               | Default    | Description                                            |
| ---------------------- | ---------- | ------------------------------------------------------ |
| `PORT`                 | `8080`     | HTTP listen port.                                      |
| `DATA_DIR`             | `/config`* | SQLite DB + generated master key.                      |
| `PUID` / `PGID`        | `1000`     | Runtime user/group (Docker only).                      |
| `RESTIC_UI_KEY`        | —          | Master key for encrypting stored credentials. Supports `RESTIC_UI_KEY_FILE`. Generated + saved under `DATA_DIR` if unset. |
| `AUTH_DISABLED`        | `false`    | Disable built-in login (only behind a trusted proxy).  |
| `TRUSTED_PROXY_HEADER` | —          | Header set by a trusted proxy carrying the user id.    |
| `RESTIC_BINARY`        | `restic`   | Override the restic executable path.                   |
| `RCLONE_BINARY`        | `rclone`   | Override the rclone executable path.                   |

\* Defaults to `./data` when run outside the container.
