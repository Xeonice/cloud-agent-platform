## Why

The archived `harden-aio-execution` change fixed 11 defects but knowingly deferred 3 honest gaps. They remain open and are all user-selected for this change: (A) codex's autonomous pty tool calls have **no working approval gate** — codex 0.131's `PreToolUse` hook does not fire (codex#16732), and the `AioApprovalEnforcer` fallback only covers the cap `/v1/shell/exec` surface, not the interactive `/v1/shell/ws` TUI where cap is a byte pipe; (B) D9 reconnect, D10 clone, and the enforcer exec-gate are code-green + unit-tested but were never exercised end-to-end on a live compose stack; (C) the derived AIO (hooks) image is ~8.97GB because it COPYs the whole built `/repo` workspace so the hooks' pnpm symlink farm resolves at runtime.

## What Changes

- **Gap A — approval enforcement effectiveness (design-level OPEN QUESTION, NOT a code fix):**
  - VERIFY on a live stack that `AioApprovalEnforcer` truly gates the cap-owned `/v1/shell/exec` boundary: `allow` proceeds; `deny` / approval-error / no-decision **FAIL CLOSED** (command does not run).
  - DECIDE + DOCUMENT the closure direction for the codex-pty surface as an explicit design decision / open question — lay out the candidate options (a: re-route codex tool calls through a cap-mediated boundary; b: parse/mediate the unstructured pty channel command-by-command; c: ACCEPT the gap and document the precise threat model — network isolation + ephemeral per-task creds + post-hoc activity report; d: wait for the codex#16732 hook fix and keep the enforcer as the exec-surface guard meanwhile). This surface may remain an **accepted threat-model gap, not a code fix**. The spec MUST NOT claim codex's autonomous pty tool calls are approval-gated when they are not.
- **Gap B — compose end-to-end regression guards:** extend the black-box e2e suite (`apps/api/test/aio-e2e.mjs` + `scripts/aio-e2e.sh`) with REAL scenarios that fossilize as regression guards:
  - **(i) reconnect replay** — a reconnecting operator replays prior output via the `@xterm/headless` `SerializeAddon` snapshot + `workspaces/<id>/session.log` tail.
  - **(ii) clone** — clone into the dedicated empty `/home/gem/workspace` succeeds (with `/v1/shell/exec` `exit_code` check), AND a forced clone failure (non-empty target / bad URL) raises a provision error with **no silent "cloned" success**.
  - **(iii) enforcer exec-gate** — the enforcer gates a cap exec command: `allow` proceeds, `deny` fails closed.
- **Gap C — slim derived image via `pnpm deploy`:** use `pnpm deploy` (`--prod`; `--legacy` if pnpm 10 requires it) to generate a self-contained `node_modules` tree for `@cap/sandbox-hooks`, and COPY only that + the compiled `dist` into the image, dropping the full `/repo` COPY — shrinking the image while keeping `import zod` / `@cap/contracts` resolvable (no `ERR_MODULE_NOT_FOUND`, hook still runs).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-events-and-approvals`: clarify the approval enforcement's REAL coverage — the cap `/v1/shell/exec` surface is gated authoritatively and fail-closed (allow proceeds; deny / approval-error / no-decision blocks), while the codex-pty (`/v1/shell/ws`) surface gap is documented with EITHER a decided closure direction OR an explicitly-accepted threat model. The spec MUST NOT claim codex's autonomous pty tool calls are approval-gated when they are not.
- `aio-sandbox-execution`: Gap B (clone provision verified end-to-end — success path plus fail-closed forced-failure with no silent success — and enforcer exec-gate verified end-to-end) + Gap C (derived image slimmed via `pnpm deploy` with hook deps still resolving at runtime).
- `realtime-terminal`: Gap B — reconnect replay (SerializeAddon snapshot + `session.log` tail) verified end-to-end on a live compose stack.

## Impact

- **Code:** `apps/api/test/aio-e2e.mjs`, `scripts/aio-e2e.sh` (new regression scenarios); the AIO hooks Dockerfile / image build for `@cap/sandbox-hooks` (Gap C `pnpm deploy` slimming); `AioApprovalEnforcer` and its `/v1/shell/exec` wiring (Gap A verification only — no behavior change asserted beyond fail-closed confirmation).
- **Build / deps:** `pnpm deploy` (`--prod`, possibly `--legacy`) introduced into the hooks image build to produce a self-contained `node_modules` for `zod` / `@cap/contracts`.
- **Specs:** `openspec/specs/agent-events-and-approvals/spec.md`, `openspec/specs/aio-sandbox-execution/spec.md`, `openspec/specs/realtime-terminal/spec.md` (each gets a MODIFIED delta; affected requirements copied verbatim-by-header).
- **External / unresolved:** codex#16732 (`PreToolUse` hook does not fire) remains an upstream blocker; the codex-pty approval gate is an OPEN QUESTION whose resolution may be an accepted threat model rather than a code change. Containment on that surface relies on cap-net network isolation (no host port) + ephemeral per-task creds + post-hoc activity report.
