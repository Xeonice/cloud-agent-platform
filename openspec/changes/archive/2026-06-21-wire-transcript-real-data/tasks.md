<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`. -->

## 1. Track: contracts (depends: none)

- [x] 1.1 In `packages/contracts/src/session-history.ts`, add an optional `at?: string` (ISO) to every `SessionTurn` member (user/assistant/tool) for the producing line's timestamp.
- [x] 1.2 Add a `SystemTurnSchema` (`kind: "system"`, `title: string`, `detail?: string`, `at?: string`, `level?: "info"|"warning"|"error"`) and include it in the `SessionTurnSchema` discriminated union; export `SystemTurn`.
- [x] 1.3 Add optional `diffstat?: { add: number; del: number }` to `ToolTurnSchema`.
- [x] 1.4 Add optional `totalTokens?: number` and `durationMs?: number` to `SessionHistoryMetaSchema`.
- [x] 1.5 Confirm all additions are optional (old durable archives parse without them); build `@cap/contracts`.

## 2. Track: backend-parser (depends: contracts)

- [x] 2.1 In `apps/api/src/sandbox/rollout-parser.ts`, carry each producing line's `timestamp` onto the emitted turn's `at` (omit when the line has none — no fabrication, no ordering inference).
- [x] 2.2 Derive `diffstat` for `apply_patch` tool turns by counting added/removed lines in the patch text already in `args`; omit for non-patch tools and for unparseable patches.
- [x] 2.3 Accumulate session `totalTokens` (sum of `token_count` deltas) and `durationMs` (last line ts − `startedAt`) into `meta`; omit each when its source data is absent (never zero/fabricate).
- [x] 2.4 Extend `rollout-parser.test.mjs`: assert `at` populated from the source line AND omitted when absent; diffstat accurate for apply_patch, absent for non-patch, absent for an unparseable patch; totals summed AND omitted when no token/timestamp data.

## 3. Track: backend-merge (depends: contracts)

- [x] 3.1 In the session-history controller/service (`session-history.controller.ts` / `session-transcript.service.ts`), fetch the task's `AuditEvent` rows by `taskId` ordered by `timestamp` (uses `@@index([taskId, timestamp])`).
- [x] 3.2 Map each audit row to a `system` turn (title per `type`: created/running/completed/failed/cancelled/agent_failed_to_start/force_failed; carry `detail`/`level`/`at` from the row; never fabricate a node id).
- [x] 3.3 Merge the system turns with the rollout-derived turns into one timestamp-ordered stream (stable sort; rollout-before-system tiebreak on equal `at`); keep the rollout parser rollout-only.
- [x] 3.4 Extend `session-history.controller.test.mjs` / `session-transcript.service.test.mjs`: audit rows become ordered system turns; parser emits no system turns; absent audit detail is omitted; durable round-trip preserves new fields; an old archive (no new fields) reads back without error.

## 4. Track: v1-public (depends: backend-merge)

- [x] 4.1 Confirm `GET /v1/tasks/:id/transcript` (`v1-transcript.controller.ts`) serializes the enriched turns via the shared session-history schema (additive, no shape divergence from console). — also merges audit system turns to match console.
- [x] 4.2 Regenerate the `GET /v1/openapi.json` document so the transcript response schema reflects the new optional fields; verify it still builds from the zod schemas (no drift). — registry now references `SessionHistorySchema` (was a stale `text/plain` string); openapi specs green.
- [x] 4.3 Add/extend a `/v1` transcript test asserting the new optional fields serialize and that omitting them stays backward-compatible.

## 5. Track: web-mock-and-route (depends: contracts)

- [x] 5.1 In `apps/web/src/lib/api/mock.ts`, extend `mockSessionHistory` to emit the new fields with FIXED timestamps (deterministic for the visual gate), including at least one `system` turn and one apply_patch diffstat across the discriminated states.
- [x] 5.2 Rewrite `apps/web/src/routes/_app/tasks/$taskId_.transcript.tsx` to consume `sessionHistoryQuery(taskId)` (read the route param), delete the `SAMPLE` constant, and render the transcript.html timeline (time gutter + system/user/commentary/tool/answer rows + diffstat + header totals) off real turns; keep filter + search; render empty/expired honest states. — also filters `system` turns out of the cockpit `SessionReplay` conv pane (server merge is shared).
- [x] 5.3 Extend `apps/web/src/lib/api/mock.test.ts`: `mockSessionHistory` still validates against `SessionHistorySchema` with the new fields populated across every discriminated state.
- [x] 5.4 Add a new vitest component test for the transcript route: filter+search narrow real turns together, each turn kind classifies (commentary ≠ answer, tool, system), clock/duration format. — repo vitest is node-env (no DOM/React render); pure logic extracted to `lib/transcript-timeline.ts` + tested there; the route's render + `taskId` wiring is covered end-to-end by the Track 6 visual gate.

## 7. Track: claude-parser-parity (depends: contracts)

- [x] 7.1 In `apps/api/src/sandbox/claude-transcript-parser.ts`, carry each user/assistant turn's `at` from its session-JSONL line `timestamp` (omit when absent), and set `meta.durationMs` from the first→last line timestamp (omit when unresolvable). `totalTokens` is honestly omitted (no clean per-turn delta in the claude JSONL).
- [x] 7.2 Add `apps/api/src/sandbox/claude-transcript-parser.test.mjs` (the parser had no test): turn extraction + final-answer marker + `at` populated/omitted + `durationMs` computed/omitted + `totalTokens` omitted + malformed-line tolerance.

## 6. Track: visual-gate (depends: web-mock-and-route)

- [x] 6.1 Confirm/activate the `transcript` entry in `apps/web/e2e/visual/manifest.ts`; the real component now renders in `VITE_FORCE_MOCK` mode. — repointed appPath to the COMPLETED `TRANSCRIPT_TASK_ID` (task `a` buckets to EMPTY history) + added `.bg-success-soft` readySelector.
- [x] 6.2 Run `VV_MEASURE=1 pnpm test:visual` to measure the transcript page delta vs `transcript.html` and record the calibrated blocking `maxDiffPixelRatio` (desktop + ≤820px) in the manifest with a rationale comment. — measured desktop 0.03 / mobile 0.06; thresholds 0.06 / 0.08 (+headroom), comment updated.
- [x] 6.3 Run `pnpm test:visual` twice back-to-back to confirm the transcript gate is deterministic (fixed mock timestamps) and passes under the recorded threshold. — both runs green (transcript @ desktop + mobile), identical results.
