## Why

Operators want task agents to run without repeated permission prompts. In practice this surfaced as recurring approval prompts for routine `git` operations, which breaks the intended unattended task flow.

The current runtime launch policy is inconsistent:

- Codex headless execution already uses the documented bypass flag.
- Codex interactive execution still uses the older approval/sandbox flag combination and preserves a stale guard that rejects YOLO-style launch flags.
- Claude Code interactive and headless execution use `acceptEdits`, which can still prompt for tool permissions.

## What Changes

- Launch interactive Codex with the documented bypass mode: `--dangerously-bypass-approvals-and-sandbox`.
- Launch interactive and headless Claude Code with `--dangerously-skip-permissions`.
- Pre-seed Claude Code user settings with `permissions.skipDangerousModePermissionPrompt=true` so the documented bypass mode does not block on a first-run dangerous-mode confirmation prompt.
- Remove the obsolete Codex launch guard that rejected `--yolo`/bypass flags.
- Keep existing task isolation unchanged: per-task AIO container, detached tmux session, prompt-file injection, terminal replay, and transcript capture remain the execution boundary and observability path.
- Update Docker image launch contract and golden tests so all runtime entry points agree.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `agent-runtime`: Codex and Claude Code runtime launch policies now use documented bypass/YOLO-style permission modes.
- `aio-sandbox-execution`: the interactive Codex terminal launch contract uses the Codex bypass flag and keeps prompt delivery file-based.
- `agent-events-and-approvals`: interactive task agents are explicitly not a pre-execution approval-gated surface under bypass mode.

## Impact

- Backend:
  - `apps/api/src/agent-runtime/codex-runtime.ts`
  - `apps/api/src/agent-runtime/claude-code-runtime.ts`
  - `apps/api/src/terminal/aio-pty-client.ts`
  - `apps/api/src/terminal/codex-launch.ts`
- Image contract:
  - `docker/aio-sandbox.Dockerfile`
- Tests:
  - `apps/api/src/agent-runtime/agent-runtime.test.mjs`
  - `apps/api/src/agent-runtime/headless-execution.spec.ts`
  - `apps/api/src/terminal/codex-launch.test.mjs`
  - `apps/api/src/terminal/codex-autostart.test.mjs`
- No database migration and no public API contract change.
