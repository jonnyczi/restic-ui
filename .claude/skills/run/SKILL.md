---
name: run
description: Launch restic-ui for manual testing — dev mode with HMR, embedded binary, or the full Docker container with seeded data. Use when asked to run/start the app or verify a change in the real UI.
---

# Running restic-ui

Pick the mode that matches what you're verifying:

## Dev mode (frontend iteration, HMR)

```sh
make run   # terminal 1: Go backend on :8080
make dev   # terminal 2: Vite on :5173, proxies /api + websockets to :8080
```

Open http://localhost:5173. Backend-only changes: restart `make run` only.

## Embedded binary (closest to production, no Docker)

```sh
make build && DATA_DIR=/tmp/restic-ui-data PORT=8080 ./bin/restic-ui
```

## Full container (the real deliverable — use for final verification)

```sh
docker build -t restic-ui:latest .
mkdir -p /tmp/rui/{config,repos,sources}
echo "hello" > /tmp/rui/sources/test.txt
docker run -d --name restic-ui-manual -p 8080:8080 \
  -e PUID=$(id -u) -e PGID=$(id -g) \
  -v /tmp/rui/config:/config -v /tmp/rui/repos:/repos \
  -v /tmp/rui/sources:/sources:ro \
  restic-ui:latest
curl -s http://localhost:8080/api/healthz   # {"status":"ok",...}
```

Clean up with `docker rm -f restic-ui-manual`.

## First run / auth

A fresh `DATA_DIR` shows the **setup page** — create any admin account
(e2e convention: `admin` / `hunter22hunter22`). To reset auth, delete the
data dir (or `restic-ui.db`) and restart.

## Gotchas

- `make run` serves whatever is in `web/dist` — if you see the placeholder
  page, run `make web` first (or use dev mode).
- Kill stray servers by port: `kill $(lsof -ti:8080)`. Do **not**
  `pkill -f restic-ui` — the pattern matches your own shell.
- Headless screenshot of the running UI:
  `chromium --headless=new --no-sandbox --virtual-time-budget=5000 --screenshot=/tmp/ui.png http://localhost:8080/`
