#!/bin/sh
# Entrypoint: reconcile the runtime user with PUID/PGID (LinuxServer.io
# convention) so files written to /config and to backup targets get the
# ownership Unraid users expect, then drop privileges and exec the app.
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
DATA_DIR="${DATA_DIR:-/config}"

# Create the runtime group/user on first run.
if ! getent group abc >/dev/null 2>&1; then
    addgroup -g "$PGID" abc 2>/dev/null || addgroup abc
fi
if ! getent passwd abc >/dev/null 2>&1; then
    adduser -D -H -u "$PUID" -G abc abc 2>/dev/null || adduser -D -H -G abc abc
fi

# Reconcile ids if the requested values differ from the current ones.
if [ "$(id -g abc)" != "$PGID" ]; then
    groupmod -o -g "$PGID" abc
fi
if [ "$(id -u abc)" != "$PUID" ]; then
    usermod -o -u "$PUID" abc
fi

# Ensure the config directory exists and is owned by the runtime user.
mkdir -p "$DATA_DIR"
chown -R abc:abc "$DATA_DIR" 2>/dev/null || true

# The runtime user has no real home; point it at the persistent data dir so
# subprocesses (ssh, rclone) get a writable HOME. This must go through the
# passwd entry — su-exec resets HOME to it, discarding any exported value.
if [ "$(getent passwd abc | cut -d: -f6)" != "$DATA_DIR" ]; then
    usermod -d "$DATA_DIR" abc
fi

echo "restic-ui: starting as uid=$PUID gid=$PGID (data_dir=$DATA_DIR)"
exec su-exec abc:abc "$@"
