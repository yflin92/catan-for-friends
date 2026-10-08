#!/usr/bin/env bash
# Game-night pre-flight (deploy/README.md, "Game night" → "Pre-flight (day of)"): the six day-of checks as one read-only
# command, printing PASS / WARN / FAIL / UNKNOWN per check and exiting 1 on any FAIL. Run it on the host from the repo
# checkout (it reads deploy/.env and deploy/backups); it needs Node 22+, and gh for the branch-protection check.
#
#   deploy/gamenight-preflight.sh --sha <deployed sha> [--repo owner/name] [--base https://<host>]
#
# See tooling/gamenight-preflight.ts for what each check reads. Nothing is written, restarted or sent anywhere but
# GET requests; secret values are only reported as set or not set.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node --experimental-strip-types --no-warnings --import ./tooling/ts-resolve-hook.mjs tooling/gamenight-preflight.ts "$@"
