# Research Brief — close-aio-execution-gaps

> Side-car working notes (not tracked). Scope: close the 3 honest gaps the
> archived `harden-aio-execution` change left behind. That change fixed 11
> defects; these 3 gaps were knowingly deferred and are all user-selected for
> this change. Everything below is grounded in hands-on verification from this
> session.

## Gap A — approval enforcement effectiveness (the design-level gap + closure options)

This is the deep, design-level gap (D8 approval-enforcement EFFECTIVENESS). It is
an **OPEN QUESTION**, not a solved problem.

### Verified state

- codex 0.131's `PreToolUse` hook does **NOT** fire (codex#16732). Tested live
  this session with `--full-auto` + `--dangerously-bypass-hook-trust` + matcher
  `.*` on a real gpt-5.5 account. The hook simply does not run.
- The cap fallback `AioApprovalEnforcer` gates the cap-owned `/v1/shell/exec`
  boundary. Its real coverage (already documented in the code):
  - **COVERED**: commands the ORCHESTRATOR itself issues into the sandbox via
    `/v1/shell/exec` (provider/orchestrator-mediated). cap brokers these, so the
    gate is authoritative *regardless* of whether the codex hook fires.
  - **GAP**: commands codex runs DIRECTLY in the interactive `/v1/shell/ws` TUI —
    its agent-loop tool calls (editing files, running shell) — are **NOT**
    mediated by the enforcer. On that surface cap is a **BYTE PIPE**, not a
    command broker. There is currently **NO effective human-in-the-loop approval
    gate** for that surface: the hook doesn't fire and the enforcer doesn't cover
    it. Containment there relies ONLY on network isolation (cap-net, no host
    port) + ephemeral per-task creds + a post-hoc activity report.

### Consequence

codex's ACTUAL agent-loop tool calls have no working approval gate. This is a
**design-level gap, NOT a code bug**. The spec MUST NOT claim codex's autonomous
pty tool calls are approval-gated when they are not.

### Work

1. **VERIFY** on a live stack that the enforcer truly gates `/v1/shell/exec`:
   - `allow` → proceeds.
   - `deny` / approval-error / no-decision → **FAIL CLOSED** (command does not
     run).
2. **Decide + document** the closure direction for the codex-pty surface. Lay the
   candidate options out in the design as an OPEN QUESTION needing an operator
   decision — do NOT pretend it is solved.

### Closure options (operator decision, OPEN QUESTION)

- **(a)** Re-route codex's tool calls through a cap-mediated boundary instead of
  direct pty exec — changes execution model A (codex-in-shell TUI).
- **(b)** Parse/mediate the interactive channel command-by-command — fragile, the
  pty is unstructured bytes.
- **(c)** ACCEPT the gap and document the threat model precisely — approval gates
  only the cap exec surface; the codex agent runs autonomously inside the
  container; containment = network isolation + ephemeral creds + post-hoc report.
- **(d)** Wait for the codex#16732 hook fix and keep the enforcer as the
  exec-surface guard meanwhile.

## Gap B — D9/D10/fallback real verification to fossilize

D9 reconnect, D10 clone, and the enforcer `/v1/shell/exec` gate are all code-green
+ unit-tested but were **NEVER run end-to-end on a live compose stack**.

- **D9 reconnect**: orchestrator persists `workspaces/<id>/session.log` + a real
  `@xterm/headless` `SerializeAddon` snapshot → replay.
- **D10 clone**: dedicated empty `/home/gem/workspace` + `/v1/shell/exec`
  `exit_code` check.
- **enforcer gate**: the `/v1/shell/exec` approval gate.

### Work

Extend the compose black-box e2e suite (`apps/api/test/aio-e2e.mjs` +
`scripts/aio-e2e.sh`) with REAL scenarios that become regression guards:

1. **(i) reconnect replay**: a reconnecting operator replays prior output
   (snapshot + `session.log` tail).
2. **(ii) clone**: clone into the empty workspace dir succeeds AND a forced clone
   failure (e.g. non-empty target / bad URL) raises a provision error with **no
   silent "cloned" success**.
3. **(iii) enforcer gate**: the enforcer gates a cap exec command — `allow`
   proceeds, `deny` fails closed.

## Gap C — image slimming

The derived AIO (hooks) image COPYs the WHOLE built `/repo` workspace (~8.97GB) so
the hooks' pnpm SYMLINK FARM (zod / `@cap/contracts`) resolves at runtime.

### Work

Use `pnpm deploy` (`--prod`; `--legacy` if pnpm 10 needs it) to generate a
SELF-CONTAINED `node_modules` tree for `@cap/sandbox-hooks`, and COPY only that +
the compiled `dist` into the image, dropping the full `/repo` COPY — shrinking the
image while keeping `import zod` / `@cap/contracts` resolvable.

### Verification

The slimmed image still resolves the hook deps (no `ERR_MODULE_NOT_FOUND`) and the
hook runs.

## Capabilities touched

All MODIFIED — build on the now-archived migrate + harden specs in
`openspec/specs/`. For each, COPY the affected requirement verbatim-by-header into
a MODIFIED block and edit.

- **agent-events-and-approvals**
  (`openspec/specs/agent-events-and-approvals/spec.md`): Gap A — the approval
  enforcement's real coverage: the cap `/v1/shell/exec` surface is gated
  authoritatively (fail-closed), and the codex-pty surface gap is documented with
  EITHER a decided closure direction OR an explicitly-accepted threat model; the
  spec MUST NOT claim codex's autonomous pty tool calls are approval-gated when
  they are not.
- **aio-sandbox-execution** (`openspec/specs/aio-sandbox-execution/spec.md`):
  Gap B (clone + exec-gate verified end-to-end) + Gap C (derived image slimmed via
  `pnpm deploy` with hook deps still resolving).
- **realtime-terminal** (`openspec/specs/realtime-terminal/spec.md`): Gap B —
  reconnect replay verified end-to-end on a live compose stack.
