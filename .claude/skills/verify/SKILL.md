---
name: verify
description: Verify a restic-ui change end-to-end — unit tests, build, and exercising the affected flow in the real Docker container / browser. Run before declaring feature work done or committing nontrivial changes.
---

# Verifying changes in restic-ui

The bar for "done" in this repo: **unit tests green AND the affected flow
exercised against the real container in a real browser.** curl-level checks
alone don't prove the React bundle or container packaging works.

## 1. Static + unit (always, fast)

```sh
go vet ./... && gofmt -l . | grep -v node_modules; go test ./...
cd web && pnpm typecheck && pnpm build && cd ..
```

`gofmt -l` printing nothing = clean. New restic argv/JSON-parsing logic gets a
table-driven test (see `internal/ops/runner_test.go` — it runs the runner
against a stub restic shell script that speaks the real JSON protocol).

## 2. E2E (the codified browser verification)

```sh
make e2e                                     # full suite, ~3 min
cd e2e && npx playwright test tests/repos.spec.ts   # just the affected spec
```

- On NixOS set `CHROMIUM_BIN=/etc/profiles/per-user/<user>/bin/chromium`
  (Playwright's downloaded browser won't run).
- Run long suites in the **foreground** — background tasks have been reaped
  mid-run in some environments.
- Specs are serial and each resets the compose env; a single spec is
  self-contained.

**Extend the suite when you add a feature** — a new user-visible flow gets a
test in the matching spec (`auth`, `repos`, `plans`, `full-flow`), using the
existing helpers (`resetEnv`, `setupAdmin`, `createLocalRepo`, `waitOpStatus`).

**If the change alters a view captured in the README** (see the slugs in
`docs/screenshots/`), refresh the screenshots too — `/screenshots` skill,
delegate the run to the `screenshot-runner` agent.

Playwright pitfalls already hit in this repo:
- Controlled React checkboxes: use `click()` + `expect(...).not.toBeChecked()`,
  never `check()`/`uncheck()` (their instant assertion races the server).
- Prefer `exact: true` on role names that collide with aria-labels
  ("sources" vs "Download sources").
- After submitting a create form, wait for the form to close (the Add button
  reappearing) before clicking inside the new card — re-renders eat clicks.

## 3. Cross-check with restic itself (for backup-semantics changes)

Anything touching what restic actually does (args, retention, excludes, copy)
gets verified with the CLI inside the container, e.g.:

```sh
docker compose -f e2e/docker-compose.test.yml exec -T \
  -e RESTIC_REPOSITORY=/repos/main -e RESTIC_PASSWORD=pass-main-repo \
  app restic snapshots --compact
```

`docker compose exec` enters as **root** (privileges drop only for the main
process). Read-only commands are fine, but anything that writes into a
local repo needs `--user $(id -u):$(id -g)` — root-owned repo files are
unreadable by the app afterwards.

## 4. Security-sensitive changes

Touching auth/crypto/secrets? Re-verify: unauthenticated → 401, mutation
without/with-wrong CSRF → 403, and `grep` the SQLite file for plaintext
secrets (see `repos.spec.ts` "secrets are not stored in plaintext").
