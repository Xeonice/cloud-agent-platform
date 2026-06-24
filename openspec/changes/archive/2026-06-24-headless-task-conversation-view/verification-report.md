# Verification Report — headless-task-conversation-view

Routing pass over the raw verify findings. Each raw-unmet requirement was re-traced
end-to-end against the actual code before routing; the skeptic was not rubber-stamped.

## Three-way routing summary

- **Reopened (real code problem):** none.
- **Spec-defect (routed to design.md Open Questions):** "Incremental read pairs a tool
  call split across polls" — the requirement prose mandates a byte-offset incremental
  read with cross-read pairing state, which the locked design decision D4 deliberately
  rejected in favor of stateless full-reparse. The scenario's observable OUTCOME is met;
  the mechanism MANDATE is internally contradictory. Not a code task.
- **Reclassified MET:** see below.

## MET requirements (re-traced as satisfied)

### `repo-and-task-management` — TaskResponse SHALL include `executionMode`
Implemented. `tasks.service.ts` (`toResponse`, line 849):
`executionMode: (task.executionMode ?? 'interactive-pty') as ExecutionMode`, sourced
from the persisted column with a `null → interactive-pty` default. `executionMode` is on
`TaskResponseSchema` in `@cap/contracts`. Round-trip asserted in `tasks-runtime.spec.ts`.

### `realtime-terminal` — a running headless task does NOT open the WS/xterm
Implemented. `sessionViewMode(status, executionMode)` (`session-view-mode.ts`) returns
`headless-live` for a running `headless-exec` task; `$taskId.tsx` renders `SessionReplay`
(polled, no socket) for that mode. `SessionTerminal` (which opens the WS) is reached only
in the `live-terminal` branch (running interactive). Interactive is untouched.

### `session-terminal-replay` — headless tasks have no asciicast and no 终端记录 tab
Implemented. Backend: `terminal.gateway.ts` line 1509 `if (mode === 'headless-exec') return;`
skips cast recording (no `sessionCasts` entry → `appendCast` no-op → cast endpoint returns
the honest empty state). Front-end: `session-replay.tsx` sets
`showTermTab={executionMode !== "headless-exec"}` so the 终端记录 tab is hidden and
`getSessionCast` is never called for headless. Interactive keeps the cast.

### `session-history-replay` — running headless serves a live, polled transcript (primary scenario)
Implemented. `session-history.controller.ts` (lines 193–202): a running
(`running`/`awaiting_input`) `headless-exec` task reads its LIVE sandbox rollout via
`readRolloutFromContainer` and returns the parsed transcript (same `parseTranscript` /
`SessionTurn` contract as a finished task), deliberately skipping durable-first and
backfill so an in-flight rollout is never frozen as the durable copy. Console polls via
`SessionReplay` `refetchInterval` 1.5s and flips to the finished transcript on terminal
status. Covered by `session-history.controller.test.mjs` (running headless → live read,
no durable read, no backfill; no-rollout → empty/no-rollout; running interactive →
durable-first unchanged). Interactive's finished-only path is unchanged.

The ONLY non-met aspect of this spec is the byte-offset-incremental MECHANISM wording in
the requirement prose (routed to Open Questions as a spec-defect, NOT a code gap).

## Gap finding (met-as-written, mechanism mismatch — does not block the primary scenario)

The spec's "Incremental read pairs a tool call split across polls" scenario requires
carrying pairing state across reads. The implementation uses full-reparse-per-poll: every
poll parses the entire rollout from scratch, so a split tool call (`function_call` in one
poll, `function_call_output` arriving later) is paired on the next full-reparse poll —
because the entire rollout is re-read, the call/output pair is resolved WITHIN that single
`parseRollout` pass via `CallPairing`. The scenario's observable outcome (ONE completed
tool turn, never dropped, never duplicated) is therefore satisfied.

However, the spec's "incremental by byte offset, parse only newly-appended lines, carry
pairing state across reads" is STRUCTURALLY DIFFERENT and is architecturally ABSENT: the
endpoint is explicitly stateless (D4), reads the whole rollout each poll, and holds no
cross-poll pending-call buffer. This mechanism mismatch is a deliberate, user-locked design
decision (D4 / tasks.md 2.2), not a defect in the code — but it means the requirement's
prose-level mechanism mandate is not implemented as written. Routed to design.md Open
Questions for the requirement prose to be reconciled with D4.

## Scope findings (behaviors implemented but not required by any spec — all benign)

These are implementation choices not mandated by any requirement. None contradict a spec;
all serve the locked decisions. Recorded for traceability, not flagged as scope-creep
needing removal.

1. **`taskQuery` polls at `refetchInterval: 4000` while the task is non-terminal**
   (`$taskId.tsx:92-98`). The specs require polling `session-history` (done at 1.5s in
   `session-replay.tsx`). Polling the task DTO is an extra reconciliation so a headless
   task flips to finished-replay on settle with no socket to reconcile it — a reasonable
   means to the spec's "switch to finished transcript on terminal status" end.

2. **`PreRunningPlaceholder` routed through the new `sessionViewMode` `pre-running` mode**
   (`session-view-mode.ts:14-15,30`, `$taskId.tsx:220-222`). The placeholder pre-existed;
   folding it into the new branching helper is a clean-up, not a new requirement.

3. **`sessionViewMode` extracted as a standalone pure module + test**
   (`session-view-mode.ts`). No spec mandates the factoring; it exists to make the
   headless-vs-interactive branch unit-testable in vitest's node env (repo convention).

4. **`armCast` split out from `initCast` in `terminal.gateway.ts`** (lines ~1492–1515).
   The spec requires only the behavior (no cast for headless); the two-method extraction
   is the means to async-gate cast arming on `executionMode`. An inline guard would also
   satisfy the requirement.
