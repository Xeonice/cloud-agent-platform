## Context

The archived `harden-aio-execution` change fixed 11 defects in the AIO-sandbox
execution layer but knowingly deferred **3 honest gaps**. All three are
user-selected for this change. They are grounded in hands-on verification from
the research session (see `research-brief.md`):

- **Gap A — approval-enforcement EFFECTIVENESS (design-level, D8 ★).** codex
  0.131's `PreToolUse` hook does **NOT** fire — verified live this session with
  `--full-auto` + `--dangerously-bypass-hook-trust` + matcher `.*` on a real
  gpt-5.5 account (codex#16732). The cap fallback `AioApprovalEnforcer`
  (`apps/api/src/sandbox/aio-approval-enforcer.ts`) gates the cap-owned
  `/v1/shell/exec` boundary fail-closed, but codex's actual agent-loop tool calls
  run DIRECTLY in the interactive `/v1/shell/ws` TUI, where cap is a **byte
  pipe**, not a command broker. On that surface there is **no working
  human-in-the-loop approval gate**. This is a design-level gap, NOT a code bug.
- **Gap B — live e2e regression guards.** D9 reconnect, D10 clone, and the
  enforcer `/v1/shell/exec` gate are code-green + unit-tested but were **never
  exercised end-to-end on a live compose stack**. The black-box suite
  (`apps/api/test/aio-e2e.mjs` + `scripts/aio-e2e.sh`) currently covers only the
  inject/exec, write-lock, and codex-start paths.
- **Gap C — derived-image slimming.** The derived AIO (hooks) image
  (`docker/aio-sandbox.Dockerfile`) `COPY --from=hooks-build /repo /opt/cap/repo`
  ships the WHOLE built `/repo` workspace (~8.97 GB) so the hooks' pnpm SYMLINK
  FARM (`zod` / `@cap/contracts`) resolves at runtime. The Dockerfile already
  documents this as a follow-up: pnpm 10 rejected a filtered `prune`, so nothing
  was slimmed.

Current state of the affected surfaces:

- `AioApprovalEnforcer.enforce`/`enforceThen` already fail closed on `deny`,
  approval error, and decision timeout. Gap A is therefore a **verification +
  honest-documentation** task on the covered surface, and an **OPEN-QUESTION**
  closure decision on the un-covered (pty) surface.
- The e2e harness already SKIPs (never fails) when the compose api is
  unreachable, so new scenarios stay CI-safe.
- The hooks build stage (`hooks-build`) already produces
  `apps/sandbox-hooks/dist`; only the COPY strategy into the final stage needs to
  change.

Stakeholders: the operator who decides whether to accept the codex-pty threat
model (Gap A is fundamentally their call), and whoever maintains the compose e2e
suite and the derived image build.

## Goals / Non-Goals

**Goals:**

- VERIFY end-to-end on a live compose stack that `AioApprovalEnforcer` truly
  gates the cap-owned `/v1/shell/exec` boundary: `allow` proceeds; `deny` /
  approval-error / no-decision **FAIL CLOSED**.
- DOCUMENT the codex-pty approval gap honestly and lay out the four closure
  options with trade-offs, marking the CHOICE as an **OPEN QUESTION** requiring an
  operator decision. The spec MUST NOT claim codex's autonomous pty tool calls are
  approval-gated when they are not.
- Compose **e2e regression guards** for reconnect replay, clone (success + forced
  fail-closed), and the enforcer exec-gate (allow/deny), fossilized in
  `apps/api/test/aio-e2e.mjs` + `scripts/aio-e2e.sh`.
- **Slim** the derived image via `pnpm deploy` so the hook deps still resolve at
  runtime (no `ERR_MODULE_NOT_FOUND`, hook still runs), dropping the full `/repo`
  COPY.

**Non-Goals:**

- Implementing option (a) or (b) for Gap A in this change. The codex-pty surface
  may remain an explicitly-accepted threat-model gap; picking and building a
  closure is **out of scope** and is gated on the operator's open-question
  decision.
- Changing the enforcer's BEHAVIOR. Gap A on the covered surface is verification
  only — no behavior change is asserted beyond confirming fail-closed.
- Changing codex's execution model (model A, codex-in-shell TUI) in this change.
- Any change to network isolation, ephemeral-creds, or the post-hoc report
  mechanisms (they are described as the EXISTING containment boundary, not
  introduced here).

## Decisions

### D1 — Verify the enforcer gates the cap exec surface fail-closed (Gap A, covered surface)

The enforcer's fail-closed contract is already implemented and unit-tested; what
is missing is a **live-stack proof**. Add an e2e scenario that drives a cap exec
command through the enforcer over the published `:8080` operator surface and
asserts:

- `allow` → the command runs (observable side effect / `exit_code`).
- `deny` / approval-error / no-decision → the command **does not run** (no side
  effect; `enforceThen` throws `ApprovalDeniedError`; fail closed).

This becomes scenario *(iii)* of Gap B and the live anchor for the
`agent-events-and-approvals` spec's "Exec surface fails closed on deny, error, or
no decision" requirement. Rationale: a unit test proves the enforcer's logic; only
an e2e proves the WIRING — that the orchestrator actually routes cap exec through
the enforcer before `/v1/shell/exec`, and that a non-allow truly blocks the real
sandbox command.

Alternative considered: trust the unit tests + code review. Rejected — the whole
point of Gap B is that "code-green + unit-tested but never run e2e" is exactly the
class of false confidence this change exists to remove.

### D2 ★ — The codex-pty approval gap: closure options (OPEN QUESTION, operator decision)

This is the deep gap. codex's ACTUAL agent-loop tool calls (editing files,
running shell inside the `/v1/shell/ws` TUI) have **no working approval gate**:
the hook doesn't fire (codex#16732) and the enforcer doesn't cover that surface
(cap is a byte pipe there). The design **does not silently pick a closure as
done**. It lays out four candidate directions, with trade-offs, and marks the
CHOICE as an open question for the operator.

- **(a) Re-route codex's tool calls through a cap-mediated boundary** instead of
  direct pty exec.
  - *Pro:* makes every codex tool call cap-brokered, so the existing enforcer
    becomes authoritative for the agent loop — the cleanest real gate.
  - *Con:* **changes execution model A** (codex-in-shell TUI). Large, invasive;
    likely loses the interactive TUI fidelity (CPR/DSR handling, live frame
    stream) the current bridge depends on. High effort, high regression risk.
- **(b) Parse / mediate the interactive channel command-by-command.**
  - *Pro:* keeps model A; no codex changes.
  - *Con:* the pty is **unstructured bytes** — reconstructing discrete commands
    from a raw terminal stream is fragile (shell line editing, multiplexers,
    escape sequences, partial frames). Easy to bypass, hard to make
    fail-closed-correct. Low confidence.
- **(c) ACCEPT the gap and document the threat model precisely.**
  - *Pro:* honest, zero new attack surface, ships now. Approval gates only the
    cap `/v1/shell/exec` surface; the codex agent runs autonomously inside the
    container; **containment = network isolation (cap-net, no host port) +
    ephemeral per-task creds + post-hoc activity report.**
  - *Con:* there is genuinely no human-in-the-loop gate on the codex agent loop;
    a malicious/confused agent can act freely WITHIN the container until the task
    ends. Acceptable only if the containment boundary is trusted.
- **(d) Wait for the codex#16732 hook fix** and keep the enforcer as the
  exec-surface guard meanwhile.
  - *Pro:* zero engineering now; if/when the hook fires, the in-band PreToolUse
    gate covers the pty surface as originally designed.
  - *Con:* **external dependency on an upstream fix** with no committed timeline
    (0.131 is a research preview). Until then the gap is exactly option (c) by
    default — so (d) is "(c) now, hope for in-band later."

**CHOICE: OPEN QUESTION — requires an operator decision.** The spec scenario
"codex-pty surface is not individually gated and is an accepted threat-model gap"
documents the gap honestly REGARDLESS of which option is later chosen; it does not
encode (a)/(b)/(c)/(d) as done. See Open Questions.

### D3 — Compose e2e regression guards for reconnect / clone / exec-gate (Gap B)

Extend the existing black-box suite rather than build a new harness, because the
suite already establishes the only topology that can exercise these paths: the
orchestrator running INSIDE the `api` container on `cap-net` with the host
docker.sock mounted, provisioning sibling `cap-aio-<taskId>` containers and
dialing them by name. New scenarios, all driven as an external operator over
`:8080` and all SKIP-gated when the api is unreachable:

- **(i) reconnect replay** — a reconnecting operator replays prior output via the
  `@xterm/headless` `SerializeAddon` snapshot + `workspaces/<id>/session.log`
  tail. Anchors the `realtime-terminal` "Reconnect replay is verified end-to-end"
  scenario. Proves the orchestrator (not the sandbox) persists `session.log`.
- **(ii) clone** — clone into the dedicated empty `/home/gem/workspace` succeeds
  with a `/v1/shell/exec` `exit_code` check, AND a **forced** clone failure
  (non-empty target / bad URL) raises a provision error with **no silent
  "cloned" success**. Anchors the `aio-sandbox-execution` clone scenarios. The
  fail-closed half is the load-bearing assertion: a provision error, not a
  swallowed failure.
- **(iii) enforcer exec-gate** — D1's allow-proceeds / deny-fails-closed
  scenario.

Rationale: each scenario fossilizes a defect class the harden change could only
assert in unit space. They run only when a live stack + built derived image are
present; CI without docker SKIPs.

### D4 — Image slimming via `pnpm deploy` (Gap C)

Replace `COPY --from=hooks-build /repo /opt/cap/repo` (the full ~8.97 GB
workspace COPY) with a `pnpm deploy`-produced **self-contained `node_modules`
tree** for `@cap/sandbox-hooks`:

- In the `hooks-build` stage, after building `@cap/contracts` and
  `@cap/sandbox-hooks`, run `pnpm deploy --filter @cap/sandbox-hooks --prod`
  (adding `--legacy` if pnpm 10 requires it) into a deploy dir. `pnpm deploy`
  rewrites the symlink farm into a real, hoisted `node_modules` so `import 'zod'`
  / `@cap/contracts` resolve **without** the `.pnpm` store back-reference.
- In the final stage, COPY only that deploy output (its `dist` +
  self-contained `node_modules`) into the image, dropping the `/repo` COPY and the
  `ln -s /opt/cap/repo/.../dist /opt/cap/dist` indirection (point `/opt/cap/dist`
  at the deployed dist directly).

Rationale: the original full-`/repo` COPY existed ONLY because the pnpm symlink
farm shipped dangling symlinks otherwise — exactly the problem `pnpm deploy` is
built to solve. The Dockerfile already names this as the follow-up and already
notes the pnpm-10 filtered-`prune` incompatibility, so `deploy` (not `prune`) is
the right tool.

Alternative considered: `pnpm --filter X prune`. Rejected — pnpm 10 rejects the
implied `--recursive` (documented in the Dockerfile; the old runner Dockerfile hit
the same wall).

Verification: build the slimmed image, run the hook, assert no
`ERR_MODULE_NOT_FOUND` and the hook executes — covered by the
`aio-sandbox-execution` "Hook dependencies still resolve at runtime in the slimmed
image" scenario and `scripts/aio-image-smoke.sh`.

## Risks / Trade-offs

- **[codex autonomous execution may be fundamentally un-gatable without changing
  execution model A.]** This is the central trade-off. While the codex hook does
  not fire (codex#16732) and codex runs in-shell over `/v1/shell/ws`, the ONLY
  ways to get a real human-in-the-loop gate on the agent loop are option (a)
  (change model A) or option (b) (fragile byte parsing). Options (c)/(d) leave the
  agent loop ungated by design. → **Mitigation:** document the threat model
  precisely and rely on the existing containment boundary (cap-net network
  isolation with no host port + ephemeral per-task creds + post-hoc activity
  report); do NOT let the spec overclaim. The cap `/v1/shell/exec` surface remains
  authoritatively gated and fail-closed regardless.
- **[Spec overclaim risk.]** If the spec says codex's pty tool calls are
  approval-gated, it lies. → **Mitigation:** the dedicated "accepted threat-model
  gap" scenario states the gap explicitly; D1's fail-closed claim is scoped to the
  cap exec surface only.
- **[e2e flakiness / environment coupling.]** Live-stack scenarios depend on a
  built derived image, docker.sock, and cap-net. → **Mitigation:** keep the
  whole-suite SKIP gate (unreachable api ⇒ skip, never fail); make timing
  assertions tolerant; prove EXECUTION via side effects absent from input (as the
  existing arithmetic-result trick does), not echo.
- **[`pnpm deploy` may need `--legacy` and could miss a transitive dep.]** A
  slimmed tree that drops a needed module reintroduces `ERR_MODULE_NOT_FOUND`,
  which makes the blocking hook fail-closed DENY on every approval. →
  **Mitigation:** the runtime hook-resolution smoke test is the gate; ship the
  slim image only after it passes. If `deploy` cannot produce a resolvable tree,
  fall back to the documented full-`/repo` COPY (functional, just large).
- **[Forced-failure clone test must assert the ERROR, not absence of success.]**
  A weak assertion could pass on a silently-swallowed failure. → **Mitigation:**
  assert a provision error is raised AND the workspace is not left in a
  half-cloned state.

## Migration Plan

1. Land the e2e scenarios (D1/D3) first — they are additive to
   `apps/api/test/aio-e2e.mjs` + `scripts/aio-e2e.sh` and SKIP without a live
   stack, so they carry no deploy risk.
2. Land the Dockerfile slimming (D4) behind the runtime hook-resolution smoke
   test. Rollback: revert to the full-`/repo` COPY (the prior, known-good layout)
   if the slim image fails to resolve hook deps.
3. Update the three spec deltas to reflect verified reality, including the honest
   codex-pty gap wording (D2).
4. Gap A closure (a/b) is NOT migrated in this change — it is gated on the
   operator's open-question decision.

Rollback strategy: each piece is independently revertible. The enforcer is
unchanged (D1 is verification only), so there is nothing to roll back there. The
image change reverts to the documented full-COPY. The e2e additions are inert when
skipped.

## Open Questions

- **★ Gap A closure direction (THE open question).** Which of (a) re-route codex
  tool calls through a cap boundary / (b) parse the pty command-by-command / (c)
  accept + document the threat model / (d) wait for codex#16732 does the operator
  choose? This is fundamentally an operator/architecture decision because it
  trades execution-model invasiveness against the existence of a real
  human-in-the-loop gate on the codex agent loop. Until decided, the effective
  posture is option (c)/(d) by default (gap accepted, containment via network
  isolation + ephemeral creds + post-hoc report), and the spec documents it as
  such — NOT as solved.
- **codex#16732 timeline.** If/when the upstream `PreToolUse` hook fires reliably,
  the in-band gate would cover the pty surface and could supersede an accepted
  threat model. No committed timeline exists (0.131 is a research preview).
- **`pnpm deploy` flag set.** Whether `--legacy` is required under the project's
  pnpm 10 and whether the deployed tree resolves every transitive hook dep — to be
  settled by the runtime smoke test before the slim image ships.
