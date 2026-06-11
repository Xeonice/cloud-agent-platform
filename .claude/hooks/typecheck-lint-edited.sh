#!/usr/bin/env bash
#
# Claude Code PostToolUse hook (Edit|Write): on edited .ts/.tsx files, run an
# ESLint check and a TypeScript typecheck so strict-TS drift is caught at
# edit-time. This is enforcement point (1) of three (the others are the husky
# pre-commit lint-staged hook and the strict base tsconfig / turbo build).
#
# Reads the hook payload as JSON on stdin and inspects the edited file path.
# Exits non-zero (blocking) when a check fails so the operator sees the error.
set -euo pipefail

# Hooks run in a non-interactive shell without the user's PATH (node is managed
# by fnm, pnpm lives in ~/Library/pnpm). Bootstrap both so node/pnpm resolve.
export PATH="$HOME/Library/pnpm:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env)" 2>/dev/null || true
fi

PAYLOAD="$(cat)"

# Extract the edited file path from the tool input (Edit/Write use file_path).
FILE="$(printf '%s' "$PAYLOAD" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const p=(j.tool_input&&(j.tool_input.file_path||j.tool_input.path))||"";process.stdout.write(p)}catch{process.stdout.write("")}})')"

# Only act on TypeScript source files.
case "$FILE" in
  *.ts | *.tsx) ;;
  *) exit 0 ;;
esac

# Locate the repo root (directory containing pnpm-workspace.yaml).
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# Find the nearest workspace member that owns this file (has a package.json).
DIR="$(dirname "$FILE")"
PKG_DIR=""
while [ "$DIR" != "$ROOT" ] && [ "$DIR" != "/" ]; do
  if [ -f "$DIR/package.json" ]; then
    PKG_DIR="$DIR"
    break
  fi
  DIR="$(dirname "$DIR")"
done

if [ -z "$PKG_DIR" ]; then
  exit 0
fi

# ESLint check on the edited file (if eslint is resolvable in the workspace).
if pnpm --filter "{$PKG_DIR}" exec eslint "$FILE" >/dev/null 2>&1; then
  :
else
  echo "ESLint check failed for $FILE" >&2
  pnpm --filter "{$PKG_DIR}" exec eslint "$FILE" >&2 || true
  exit 2
fi

# TypeScript typecheck for the owning member (project-wide, strict).
if pnpm --filter "{$PKG_DIR}" run typecheck >/dev/null 2>&1; then
  :
else
  echo "TypeScript typecheck failed for member $PKG_DIR (edited $FILE)" >&2
  pnpm --filter "{$PKG_DIR}" run typecheck >&2 || true
  exit 2
fi

exit 0
