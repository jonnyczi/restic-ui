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
destination folder for local repositories — see `docker-compose.yml`. An
Unraid Community Applications template is provided in `unraid-template.xml`.

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
make docker     # -> restic-ui:latest
# or
docker compose up --build
```

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
