<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: decide-pty-approval (depends: none)

<!-- DESIGN DECISION / OPERATOR-GATE TRACK (Gap A, D2 ★). This is NOT a code-only
     task: it requires an OPERATOR DECISION among the four closure options before
     the codex-pty spec wording can be finalized. Touches only the
     agent-events-and-approvals spec + design Open Questions. -->

- [ ] 1.1 OPERATOR DECISION GATE: choose the codex-pty (`/v1/shell/ws`) closure direction among the four options in design.md D2 — (a) re-route codex tool calls through a cap-mediated boundary, (b) parse/mediate the unstructured pty channel command-by-command, (c) ACCEPT the gap + document the precise threat model (cap-net network isolation with no host port + ephemeral per-task creds + post-hoc activity report), (d) wait for the codex#16732 `PreToolUse` hook fix and keep the enforcer as the exec-surface guard meanwhile. Record the chosen direction and rationale. Verifiable: a single decision is written down with its trade-off justification.
- [ ] 1.2 Resolve the "★ Gap A closure direction" Open Question in `design.md` to reflect the chosen option (or, if deferred, the explicit default posture: option (c)/(d) — gap accepted, containment via network isolation + ephemeral creds + post-hoc report). Verifiable: the Open Questions section no longer leaves the direction unstated.
- [ ] 1.3 Finalize the `agent-events-and-approvals` spec scenario "codex-pty surface is not individually gated and is an accepted threat-model gap" so it documents the gap HONESTLY per the decision. The spec MUST NOT claim codex's autonomous pty tool calls are approval-gated when they are not. Verifiable: scenario text matches the recorded decision and contains no overclaim that the pty agent loop is gated.

## 2. Track: verify-exec-gate (depends: none)

<!-- Gap A covered-surface verification (D1). Live-stack proof that the existing
     AioApprovalEnforcer gates the cap-owned /v1/shell/exec boundary fail-closed.
     Verification + spec wording only; NO enforcer behavior change. -->

- [ ] 2.1 Review `apps/api/src/sandbox/aio-approval-enforcer.ts` (`enforce`/`enforceThen`) and confirm the wiring: the orchestrator routes cap exec through the enforcer BEFORE calling `/v1/shell/exec`. Document the call path that the live-verify scenario will exercise. Verifiable: the exec → enforcer → `/v1/shell/exec` path is identified in code with file/line references.
- [ ] 2.2 Live-verify on a running compose stack (driving the published `:8080` operator surface) that an `allow` decision lets the cap exec command run — assert an observable side effect / `exit_code`, not echo. Verifiable: the command's effect is present when the decision is `allow`.
- [ ] 2.3 Live-verify the fail-closed half: `deny`, approval-error, and no-decision (timeout) each BLOCK the cap exec command — `enforceThen` throws `ApprovalDeniedError`, the command does NOT run, and no side effect is observable. Verifiable: each of the three non-allow paths produces no side effect and a thrown denial.
- [ ] 2.4 Update the `agent-events-and-approvals` spec scenario "Exec surface fails closed on deny, error, or no decision" to reflect the verified live behavior, scoped strictly to the cap `/v1/shell/exec` surface (no claim about the pty surface). Verifiable: the scenario states allow-proceeds / deny-error-no-decision-fails-closed for the exec surface only.

## 3. Track: compose-e2e-guards (depends: verify-exec-gate)

<!-- Gap B (D3). Extend the existing black-box suite with REAL regression
     scenarios, all driven as an external operator over :8080 and all SKIP-gated
     when the compose api is unreachable. Shared files apps/api/test/aio-e2e.mjs +
     scripts/aio-e2e.sh ⇒ one track. Depends on verify-exec-gate so scenario (iii)
     encodes the verified exec-gate semantics. -->

- [ ] 3.1 Confirm/extend the whole-suite SKIP gate in `apps/api/test/aio-e2e.mjs` + `scripts/aio-e2e.sh` so all new scenarios SKIP (never fail) when the compose api on `:8080` is unreachable. Verifiable: running the suite without a live stack reports SKIP, not failure.
- [ ] 3.2 Add scenario (i) reconnect replay to `apps/api/test/aio-e2e.mjs`: a reconnecting operator replays prior output via the `@xterm/headless` `SerializeAddon` snapshot + `workspaces/<id>/session.log` tail; assert prior output is replayed and that the ORCHESTRATOR (not the sandbox) persists `session.log`. Anchors `realtime-terminal` "Reconnect replay is verified end-to-end on a live compose stack". Verifiable: prior output reappears on reconnect on a live stack.
- [ ] 3.3 Add scenario (ii-success) clone success: clone into the dedicated empty `/home/gem/workspace` succeeds, asserted via a `/v1/shell/exec` `exit_code` check. Anchors `aio-sandbox-execution` "Clone success is verified end-to-end on a live compose stack". Verifiable: clone completes and the exec exit_code check passes on a live stack.
- [ ] 3.4 Add scenario (ii-failure) forced clone failure: a non-empty target / bad URL raises a PROVISION ERROR with NO silent "cloned" success, and the workspace is not left half-cloned. The assertion must verify the ERROR is raised, not merely the absence of success. Anchors `aio-sandbox-execution` "Forced clone failure fails closed end-to-end with no silent success". Verifiable: a provision error is observed and no false "cloned" success occurs.
- [ ] 3.5 Add scenario (iii) enforcer exec-gate (from D1/verify-exec-gate): drive a cap exec command through the enforcer over `:8080` — `allow` proceeds (observable side effect / `exit_code`), `deny` fails closed (no side effect). Anchors `aio-sandbox-execution` "Enforcer exec-gate is verified end-to-end on a live compose stack". Verifiable: allow runs, deny does not, on a live stack.
- [ ] 3.6 Wire all four new scenarios into `scripts/aio-e2e.sh` so they execute under the existing harness ordering. Verifiable: the script runs the reconnect, clone-success, clone-failure, and exec-gate scenarios when a live stack is present and SKIPs them otherwise.

## 4. Track: slim-image (depends: none)

<!-- Gap C (D4). Replace the full /repo COPY with a pnpm deploy self-contained
     node_modules tree for @cap/sandbox-hooks. Touches only the Dockerfile + image
     smoke test; disjoint from the e2e + spec/approval tracks. -->

- [ ] 4.1 In the `hooks-build` stage of `docker/aio-sandbox.Dockerfile`, after building `@cap/contracts` and `@cap/sandbox-hooks`, run `pnpm deploy --filter @cap/sandbox-hooks --prod` (add `--legacy` if pnpm 10 requires it) into a deploy dir so the symlink farm is rewritten into a real hoisted `node_modules`. Verifiable: the deploy dir contains a self-contained `node_modules` with `zod` + `@cap/contracts` as real (non-dangling) entries.
- [ ] 4.2 In the final stage of `docker/aio-sandbox.Dockerfile`, COPY only the deploy output (its `dist` + self-contained `node_modules`), drop `COPY --from=hooks-build /repo /opt/cap/repo`, and point `/opt/cap/dist` directly at the deployed dist (removing the `ln -s /opt/cap/repo/.../dist /opt/cap/dist` indirection). Verifiable: the Dockerfile no longer references the full `/repo` COPY or the symlink indirection.
- [ ] 4.3 Build the slimmed image and run the hook via `scripts/aio-image-smoke.sh`: assert NO `ERR_MODULE_NOT_FOUND` (`import 'zod'` / `@cap/contracts` resolve) and the hook executes. Anchors `aio-sandbox-execution` "Hook dependencies still resolve at runtime in the slimmed image". Verifiable: the smoke test passes (hook runs, deps resolve). If `deploy` cannot produce a resolvable tree, fall back to the documented full-`/repo` COPY per the design rollback.
- [ ] 4.4 Confirm the slimmed image is smaller than the prior full-`/repo` (~8.97 GB) build and update the `aio-sandbox-execution` spec scenario "Derived image is slimmed via pnpm deploy without a full /repo COPY" to reflect the verified build. Verifiable: measured image size is reduced and the scenario matches the shipped Dockerfile strategy.
