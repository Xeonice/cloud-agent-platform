# Verification Report — wire-transcript-real-data

Three-way adjudication of the raw-unmet requirements after end-to-end re-trace
against the actual code. All eight raw-unmet requirements re-trace as **MET**.
No requirement re-opened as a code task; no requirement routed to a spec defect.

## Reclassified MET (re-traced end-to-end despite the skeptic's refutation)

### session-history-replay

1. **The dedicated transcript route renders real session-history data** — MET.
   `apps/web/src/routes/_app/tasks/$taskId_.transcript.tsx` reads `Route.useParams()`
   `taskId` and issues `useQuery(sessionHistoryQuery(taskId))`; the `SAMPLE`
   constant is gone. It renders the transcript.html timeline (56px time gutter +
   typed system/user/commentary/tool/answer rows + diffstat + header totals),
   applies `filterTurns(turns, filter, search)` (filter + search together), and
   renders honest `expired` / `empty` / 没有匹配的记录 states. The history
   「查看会话」 entry targets this route (visual-gate `manifest.ts` `appPath:
   /tasks/${TRANSCRIPT_TASK_ID}/transcript`).

2. **Parsed turns carry their source timestamp** — MET (with an out-of-scope gap
   that does not block the primary scenario). `rollout-parser.ts` carries
   `...atOf(line)` onto every emitted turn (user/assistant/tool) and omits `at`
   when the line has no `timestamp` (`atOf` returns `{}`). The schema field is
   `at?: string` (optional). The skeptic's refutation — that
   `claude-transcript-parser.ts` does NOT carry `at` — targets a parser badged
   `add-headless-execution-track` (see Scope findings); the spec requirement is
   written about "the rollout line that produced it" and the proposal Impact
   section scopes this requirement to `rollout-parser.ts` only. The codex-rollout
   primary scenario is fully satisfied.

3. **System milestone turns are merged from the audit timeline** — MET.
   `session-history.controller.ts` defines `auditToSystemTurn` (maps an audit row
   to a `system` turn, omitting `detail` when absent, never fabricating a node id)
   and `mergeSystemTurns` (stable timestamp-ordered merge, rollout-before-system
   tiebreak). The pure `rollout-parser.ts` emits no `system` turns. The merge runs
   in `toAvailable`, best-effort (an audit read failure falls back to rollout-only).

4. **Tool turns carry an apply-patch diffstat** — MET. `rollout-parser.ts`
   `patchDiffstat(args)` counts `+`/`-` lines excluding `+++`/`---` headers, is
   applied ONLY for `toolName === 'apply_patch'`, and returns `undefined`
   (→ omitted) for a non-patch body or a patch with no +/- lines. The `diffstat`
   field is optional on `ToolTurnSchema`.

5. **Session-history meta carries session totals** — MET (with the same
   out-of-scope claude-parser gap as #2). `rollout-parser.ts` accumulates
   `sessionTokens` from `token_count` deltas and sets `meta.totalTokens` only when
   `sawTokens && sessionTokens > 0`; it sets `meta.durationMs` only when both
   `startedAt` and `lastTimestamp` resolve to a finite `ms >= 0`. Both omitted
   (never zeroed) otherwise. Schema fields are optional. The claude parser not
   computing totals is `add-headless-execution-track` scope.

6. **New transcript fields are additive and backward-compatible** — MET. Every
   addition in `packages/contracts/src/session-history.ts` is `.optional()`
   (`at`, `diffstat`, `totalTokens`, `durationMs`) and the `system` kind is an
   additional union member, so an old durable archive parses with the fields
   simply absent and `SessionReplay` ignores fields it does not read.

### public-v1-api

7. **/v1 transcript surfaces the enriched transcript fields** — MET.
   `v1-transcript.controller.ts` parses via `parseTranscript` and runs the SAME
   `auditToSystemTurn` + `mergeSystemTurns` imported from
   `session-history.controller.ts`, validating through the shared
   `SessionHistorySchema` — so per-turn `at`, `system` turns, diffstat, and totals
   serialize identically to the console. Additive/optional ⇒ backward-compatible.

8. **OpenAPI document reflects the enriched transcript schema** — MET.
   `apps/api/src/openapi/openapi.registry.ts` references `SessionHistorySchema`
   directly for the `/v1/tasks/{id}/transcript` 200 response (was a stale
   `text/plain` string), so the document is generated from the same zod schema
   used for validation — no drift.

## Gap finding (skeptic's "no traceable implementation" claim)

The skeptic asserted some requirements have no traceable implementation. Re-trace
refutes this: all six session-history-replay requirements and both public-v1-api
requirements have a complete implementation on the codex-rollout primary path.
The only real shortfall the skeptic surfaced is that
`apps/api/src/sandbox/claude-transcript-parser.ts` does not carry `at` on
user/assistant turns (lines 85, 92-97) and does not compute `totalTokens` /
`durationMs`. That parser is a SECONDARY runtime parser owned by a DIFFERENT
change (`add-headless-execution-track`), not in this change's scope (see below);
its gaps are an implementation gap for that change, not a complete absence of the
feature in this one. Verdict: every requirement is met-as-written; the claude
parser gap does not block any primary scenario of wire-transcript-real-data.

## Scope findings (implemented behaviors with NO requirement in these specs)

These behaviors are present in the touched files but are NOT required by any
requirement of wire-transcript-real-data. They belong to other changes or are
downstream UX consequences; recorded here so the spec/code boundary is explicit.

1. **`ToolTurn.tokenCount` per-turn field** — contract
   (`packages/contracts/src/session-history.ts:74`), parser population
   (`apps/api/src/sandbox/rollout-parser.ts:199-205`), and transcript-route display
   (`apps/web/src/routes/_app/tasks/$taskId_.transcript.tsx:258-260`). The specs
   require per-turn token deltas only as INPUT to `meta.totalTokens`; surfacing the
   per-turn count as a turn-level wire field is not a requirement here.

2. **Multi-runtime transcript dispatch** — `parseTranscript` → `parseClaudeTranscript`
   vs `parseRollout` (`apps/api/src/sandbox/parse-transcript.ts:1-20`) and the
   `transcriptFormatForRuntime` calls in both controllers
   (`session-history.controller.ts:181-182`, `v1-transcript.controller.ts:87-88`).
   The specs are codex-rollout-only; runtime dispatch belongs to
   `add-headless-execution-track` / `add-claude-code-runtime`.

3. **`apps/api/src/sandbox/claude-transcript-parser.ts`** — the entire Claude Code
   session-JSONL parser (file header self-identifies as `add-headless-execution-track`).
   No requirement or task of wire-transcript-real-data mentions claude-jsonl parsing.

4. **`stripPromptWrapper` + `sawUserMessageEvent` codex-exec fallback** in
   `rollout-parser.ts:62-82, 146, 255-264` — recovers the user prompt from a
   `response_item message role=user` when no `event_msg user_message` events exist
   (non-interactive `codex exec`). No spec scenario covers non-interactive exec.

5. **`SessionReplay` cockpit system-turn filter** — `apps/web/src/components/session/session-replay.tsx`
   filters `kind !== 'system'` out of the `/tasks/$taskId` conv pane (the server
   merge is shared). Not a requirement in either spec; it appears only as a
   tasks.md annotation, a downstream UX consequence of the shared merge.
