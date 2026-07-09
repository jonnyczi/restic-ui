#!/usr/bin/env bash
# Reset the e2e test environment to a pristine state: fresh app config, empty
# repos, seeded source data, and (re)started containers.
set -euo pipefail
cd "$(dirname "$0")"

docker compose -f docker-compose.test.yml down --remove-orphans >/dev/null 2>&1 || true

rm -rf .testenv
mkdir -p .testenv/config .testenv/repos .testenv/restore \
         .testenv/sources/docs .testenv/sources/photos

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
