---
name: screenshots
description: Regenerate the README screenshots in docs/screenshots/ — stage demo data, capture dark+light shots, compress to WebP, verify. Use after UI changes that alter any captured view, or when asked to refresh README images.
---

# Regenerating the README screenshots

`e2e/screenshots/` is a standalone Playwright project (NOT run by `make e2e`).
`01-stage.spec.ts` resets the e2e compose env and stages ~3 weeks of
backdated demo data through the real app: two repos (local + MinIO S3),
three plans, 18 backups including one genuine warning run. Backdating is
consistent across restic (`rewrite --new-time` per snapshot) and SQLite
(operations/logs/stats shifted, durations preserved). `02-capture.spec.ts`
shoots each view dark+light into `e2e/screenshots/raw/` (gitignored);
`scripts/compress-screenshots.sh` writes the committed
`docs/screenshots/*.webp`.

## Running

Delegate full runs to the `screenshot-runner` agent. Manually:

```sh
cd e2e && PUID=$(id -u) PGID=$(id -g) docker compose -f docker-compose.test.yml build app
CHROMIUM_BIN=/etc/profiles/per-user/<user>/bin/chromium npm run screenshots
cd .. && nix-shell -p libwebp --run ./scripts/compress-screenshots.sh
```

To re-capture a single shot against a still-staged env:
`npm run screenshots -- 02-capture --grep "<test name>"`. Some capture
tests depend on the previous test's open panel (the repo-panel sequence) —
grep the panel-opening test too.

## Verifying

- Pairs: every `-dark.webp` has a `-light.webp` and vice versa.
- Budget: `find docs/screenshots -name '*.webp' -size +150k` prints nothing.
- Refs: `grep -o 'docs/screenshots/[a-z0-9-]*\.webp' README.md | sort -u | xargs ls`.
- **Eyeball every changed image in both themes** (Read tool renders them):
  no toasts, no empty charts, no theme mismatch, no real secrets (secret
  inputs are masked; all staged values are fake).

## Adding or changing a shot

Add a test in `02-capture.spec.ts` using the `shoot()` helper (captures
dark, toggles theme in place so expanded panels survive, captures light);
use `clipShot()` for partial-card crops. Pick a new slug, then add the
matching `<picture>` block to README.md.

## Gotchas

- Staging **destroys `e2e/.testenv`** — never run alongside `make e2e`.
- `docker compose exec` enters as **root** (privileges drop only for the
  main process). The stage helpers pass `--user` because root-owned files
  written into a local repo are unreadable by the app afterwards; keep that
  in any new helper.
- Retention is added only *after* backdating — a retention run during
  staging would collapse the same-day snapshots to one.
- The dashboard "overdue" heuristic gives daily/weekly crons only 2 days
  grace, so scheduled plans' last runs are pinned to T-1 in the timeline.
- The Media plan's 8 MiB/s upload cap creates the ~30 s window for the
  live-progress shot; feed it fresh random media before running.
- The nix-shell profile hook may drop `tmp/` and `.fake-pkgconfig/` into
  the repo cwd — delete them, never commit them.
