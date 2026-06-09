#!/usr/bin/env bash
# Tear down the local dev stack (local-one-click-dev). NON-DESTRUCTIVE by default:
# `docker compose down` removes containers + networks but PRESERVES the named
# `pgdata` / `workspaces` volumes. Dropping the volumes (data loss) requires the
# explicit -v / --volumes opt-in — it is never the default.
#
#   scripts/dev-down.sh        # stop the stack, keep volumes
#   scripts/dev-down.sh -v     # stop the stack AND drop pgdata/workspaces (destructive)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

DROP_VOLUMES=0
for arg in "$@"; do
  case "$arg" in
    -v|--volumes) DROP_VOLUMES=1 ;;
    -h|--help)
      echo "usage: dev-down.sh [-v|--volumes]"
      exit 0
      ;;
    *) echo "dev-down: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

command -v docker >/dev/null 2>&1 || {
  echo "dev-down: required tool 'docker' not found on PATH" >&2
  exit 1
}

if [ "$DROP_VOLUMES" -eq 1 ]; then
  echo "dev-down: stopping the stack AND dropping pgdata/workspaces volumes (DESTRUCTIVE)…"
  docker compose down -v
else
  echo "dev-down: stopping the stack (volumes preserved; pass -v to drop them)…"
  docker compose down
fi
