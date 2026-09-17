#!/bin/sh
# statera keeper, cron entry point.
#
# A convenience wrapper for running the keeper by hand, and on a host where the
# installed cron line would rather not carry six assignments.
#
# flock is the outer guarantee that two runs never overlap; the Node script also
# takes its own lockfile, because macOS has no flock(1) and a double post costs real
# OKB. Note they are DIFFERENT paths on purpose: flock(1) holds its file open for the
# life of the run, so pointing the script's own lock at the same path would have it
# try to break a lock that is legitimately held.
#
# The deployed cron does not use this wrapper -- it names node, the lock, the log and
# every variable explicitly, so that reading `crontab -l` tells the whole story. See
# the "On the VPS" section of DEPLOYMENT.md for that line.
#
# Required: STATERA_FEED. Sending also needs --post and STATERA_KEY.
# Without --post the run measures, decides and estimates gas, but sends nothing.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCK="${STATERA_LOCK_FILE:-/var/lock/statera-keeper.lock}" # outer flock; the script uses STATERA_LOCK

cd "$ROOT"
if command -v flock >/dev/null 2>&1; then
  exec flock -n "$LOCK" node dist/src/keeper.js "$@"
fi
# No flock on this host (macOS): the script's own lockfile still serialises runs.
exec node dist/src/keeper.js "$@"
