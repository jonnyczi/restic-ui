---
name: ci
description: Check, watch, or debug GitHub Actions runs for this repo (jonnyczi/restic-ui). Use after pushing, or when asked about CI status or failures.
---

# CI for jonnyczi/restic-ui

The workflow (`.github/workflows/ci.yml`) has four jobs: backend
(vet/test/gofmt), frontend (typecheck/build), e2e (Docker + Playwright),
and docker (multi-arch buildx → GHCR on main/tags).

## Account gotcha (important)

This repo is **private under the `jonnyczi` account**, but the default `gh`
login on this machine is the work account (`jonathan-mytime`) — plain `gh`
gets 404s. Use the personal config for every command:

```sh
export GH_CONFIG_DIR=~/.config/gh-personal   # or prefix each command
```

(Equivalently the shell alias `gh-personal`, but aliases aren't available in
non-interactive shells.) Git pushes already work — the repo has a local
`core.sshCommand` pointing at `~/.ssh/id_ed25519_jonnyczi_gh`.

## Common operations

```sh
GH_CONFIG_DIR=~/.config/gh-personal gh run list  --repo jonnyczi/restic-ui --limit 5
GH_CONFIG_DIR=~/.config/gh-personal gh run view  <run-id> --repo jonnyczi/restic-ui
GH_CONFIG_DIR=~/.config/gh-personal gh run view  <run-id> --repo jonnyczi/restic-ui --log-failed
GH_CONFIG_DIR=~/.config/gh-personal gh run watch <run-id> --repo jonnyczi/restic-ui --exit-status
```

Filtering the e2e job's noisy log down to test results:

```sh
... gh run view <run-id> --repo jonnyczi/restic-ui --log 2>&1 \
  | grep "Run e2e suite" | sed 's/^.*Run e2e suite\t//' \
  | grep -E "✓|✘|failed|passed|Error|rm:|denied"
```

## Known CI-vs-local differences

- Runner uid is **1001** (locally usually 1000) — any uid-sensitivity in the
  e2e compose env shows up only on CI. All compose calls must carry the same
  `PUID`/`PGID` (helpers.ts does this); `reset-env.sh` has a root-container
  fallback for foreign-owned files.
- CI uses Playwright's downloaded Chromium (`--with-deps`); locally NixOS
  needs `CHROMIUM_BIN`.
- Failed e2e runs upload `test-results/` (traces + error contexts) as the
  `playwright-results` artifact:
  `... gh run download <run-id> --repo jonnyczi/restic-ui -n playwright-results`
