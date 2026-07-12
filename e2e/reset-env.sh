#!/usr/bin/env bash
# Reset the e2e test environment to a pristine state: fresh app config, empty
# repos, seeded source data, and (re)started containers.
set -euo pipefail
cd "$(dirname "$0")"

docker compose -f docker-compose.test.yml down --remove-orphans >/dev/null 2>&1 || true

# Volumes may contain files owned by another uid (e.g. if a container ran with
# a different PUID); fall back to a root container to clear those.
if ! rm -rf .testenv 2>/dev/null; then
  echo "reset-env: falling back to container-based cleanup"
  docker run --rm -v "$(pwd):/work" -w /work alpine:3.20 rm -rf .testenv
fi
mkdir -p .testenv/config .testenv/repos .testenv/restore \
         .testenv/sources/docs .testenv/sources/photos .testenv/sshkeys

# Throwaway keypair for the SFTP test container (BatchMode forbids passwords).
ssh-keygen -t ed25519 -N "" -q -f .testenv/sshkeys/id_ed25519

echo "hello world" > .testenv/sources/docs/a.txt
echo "# notes" > .testenv/sources/docs/b.md
dd if=/dev/urandom of=.testenv/sources/docs/big.bin bs=1M count=8 status=none
echo "temp junk" > .testenv/sources/docs/skip.tmp
echo "img" > .testenv/sources/photos/img1.jpg

# Run the app as the current user so files it writes (restores, repos) are
# readable by the test process.
export PUID PGID
PUID=$(id -u)
PGID=$(id -g)

docker compose -f docker-compose.test.yml up -d --wait
