## Context

The `/tasks/$taskId/transcript` route renders a hardcoded `SAMPLE` constant; it
never reads `taskId` and issues no query (verified in
`apps/web/src/routes/_app/tasks/$taskId_.transcript.tsx`). The history page's
「查看会话」 link is its only entry point. The data wiring was deferred in
`pixel-restore-console-to-od` (Track 11) and never landed.

The real read path is already shipped: `GET /tasks/:id/session-history`
(`session-history-replay`, durable-first via `session-transcript-persistence`)
returns a parsed `@cap/contracts` `SessionHistory`, consumed by the
`SessionReplay` component on `/tasks/$taskId`. The dedicated transcript route is
a second, divergent UI (transcript.html timeline) that was never connected to
this data.

The operator chose the FULL scope (TIER 0–3): wire the timeline to real data AND
enrich the contract with per-turn timestamps, header totals, tool diffstat, and
audit-sourced system milestone rows.

Constraints inherited from the existing capability:
- The rollout parser is PURE and rollout-only; cross-source concerns live in the
  controller/service layer (it already holds `TasksService` access).
- Resolution is durable-first; the durable archive (`SessionTranscript`) holds
  rollouts parsed under the OLD schema — new fields must be additive-optional.
- The real/mock seam is gated by the `sessionHistory` capability flag.
- The public `/v1/tasks/:id/transcript` controller serializes the same turns.

## Goals / Non-Goals

**Goals:**
- `/tasks/$taskId/transcript` renders real `SessionHistory` data; the `SAMPLE`
  constant is deleted and `taskId` is actually consumed.
- The transcript.html timeline form is preserved (time gutter, typed rows,
  filter + search, empty state).
- The contract carries per-turn timestamps, tool diffstat, session totals
  (tokens + duration), and audit-sourced `system` milestone turns.
- All new fields are additive-optional so the existing `SessionReplay` renderer
  and historical durable archives keep working.
- Each layer (parser / controller-merge / contract seam / route component /
  visual gate) has verification matching repo conventions.

**Non-Goals:**
- No change to the durable-first resolution, the 5-state discriminated contract,
  credential non-export, or the live WebSocket/PTY pipeline.
- No backfill/re-parse migration of historical durable archives (they degrade to
  honest omission of the new fields).
- No new audit event types (e.g. a `sandbox.allocated` node id) — we consume the
  existing `AuditEvent` types only.
- The `SessionReplay` component's sidebar layout on `/tasks/$taskId` is NOT
  re-styled to the timeline; both renderers coexist over one contract.

## Decisions

### D1 — Keep the transcript.html timeline as a distinct renderer (not redirect to SessionReplay)
The operator selected 方案 2. The dedicated route renders the timeline form
(56px time gutter + typed rows) faithful to `design-baseline/screens/transcript.html`,
fed by `sessionHistoryQuery`. Rationale: the timeline is a deliberately distinct,
denser review surface from the session-page sidebar replay.
- Alternative (方案 1, redirect 「查看会话」 → `/tasks/:id`): rejected by the
  operator — it would abandon the timeline design.

### D2 — Per-turn timestamps: carry the existing source field, don't invent one
Each rollout line is `{timestamp, type, payload}`; the parser already reads
`line.timestamp` for `session_meta` but drops it on turns. Add an optional
`at?: string` (ISO) to each `SessionTurn` and populate it from the producing
line's timestamp. No new source data is needed.
- Alternative (synthesize times from ordering): rejected — fabrication; the real
  timestamp is right there.

### D3 — System milestone turns: a new `kind: "system"`, merged in the controller from `AuditEvent`
Add `SystemTurnSchema` (`kind: "system"`, `title`, `detail?`, `at`, `level`) to
the discriminated `SessionTurn` union. The PARSER does NOT produce system turns
(it stays rollout-pure). The controller/service fetches
`AuditEvent WHERE taskId=? ORDER BY timestamp` (the `@@index([taskId, timestamp])`
backs this), maps each to a system turn, and MERGES it with the rollout turns by
timestamp into one ordered stream. The merge is well-ordered because D2 gives
every rollout turn an `at`.
- Title mapping: `task.created`→任务创建, `task.running`→沙箱就绪/开始运行,
  `task.completed`→任务完成, `task.failed`→任务失败, `task.cancelled`→任务取消,
  `agent_failed_to_start`/`force_failed`→carry the audit `title`/`description`.
- Honest omission: where the audit row carries no node id, none is shown (the
  mock's "已分配 iad-02-01" has no source field — not fabricated).
- Alternative (parse lifecycle from rollout `event_msg task_started/complete`):
  rejected — only partial, and the richer CAP framing (repo · change) lives in
  the task/audit data, not the rollout. `AuditEvent` is the authoritative,
  already-indexed source.

### D4 — Tool diffstat: derive from the apply_patch turn's patch text in the parser
Add optional `diffstat?: { add: number; del: number }` to `ToolTurn`. For an
`apply_patch` turn, the parser counts added/removed hunk lines in the patch body
already captured in `args`. Non-patch tools and unparseable patches carry no
diffstat.
- Alternative (a dedicated wire field from codex): rejected — codex does not emit
  a diffstat; the patch text is the only source and it is already in `args`.

### D5 — Header totals on `SessionHistoryMeta`
Add optional `totalTokens?: number` (sum of the rollout `token_count` deltas) and
`durationMs?: number` (last line ts − `startedAt`). Computed in the parser from
data it already walks. Branch / repo / agent / task status for the header come
from the TASK row (already available via the task read path), NOT from this
contract.

### D6 — Additivity guarantees the durable archive and the SessionReplay renderer
Every new field is OPTIONAL. Old `SessionTranscript` archives (parsed pre-change)
deserialize without the fields → renderers treat them as absent. `SessionReplay`
ignores fields it does not read. No archive migration is run.

### D7 — Public `/v1` is additive; regenerate the OpenAPI doc
`v1-transcript.controller.ts` serializes the enriched turns; the OpenAPI document
is regenerated. Because every field is optional/additive, no `/v2` is needed.

## Risks / Trade-offs

- **Audit/rollout clock skew across sources** → both timestamps are server-side
  UTC (`AuditEvent.timestamp` server-assigned; rollout line ts from codex on the
  same host); merge is a stable sort by ts with rollout-before-system tiebreak so
  identical timestamps render deterministically.
- **Old durable archives lack new fields** → additive-optional contract; the
  timeline degrades (no diffstat/totals, system rows still available since they
  come from AuditEvent live, not the archive). Documented as accepted.
- **Visual-gate non-determinism from real timestamps** → the mock
  (`mockSessionHistory`) MUST emit FIXED timestamps; the existing harness already
  fixes relative times to constant offsets. Calibrate the `transcript` threshold
  with `VV_MEASURE` after wiring.
- **Patch-format drift breaks diffstat** → counting is best-effort; a patch the
  counter cannot parse yields NO diffstat rather than a wrong number (honest
  omission), covered by a negative parser test.
- **Two renderers over one contract diverge** → mitigated by the shared
  `@cap/contracts` schema as the single source of truth; both renderers
  Zod-`.parse` the same payload.

## Migration Plan

1. Land contract + parser + controller-merge + tests (backend), additive only.
2. Land mock fields + transcript route wiring + component test + visual gate.
3. Regenerate `/v1` OpenAPI doc.
4. Deploy; the `sessionHistory` flag already gates the seam (flip to real in the
   live env if not already). No DB migration (additive-optional, no schema
   change to `SessionTranscript` storage shape — the stored JSON simply gains
   optional keys for newly-parsed tasks).
- **Rollback**: revert the web route to the prior commit (SAMPLE) and the
  contract/parser additions; old archives are unaffected (fields were optional).

## Open Questions

- Should `task.running` render as 「沙箱就绪」 or 「开始运行」? (Default: 「开始运行」;
  the mock's 「沙箱就绪」 maps to the same audit row — resolve during apply against
  the actual audit titles.)
- Do we surface `force_failed` / `agent_failed_to_start` as system rows in the
  timeline, or rely on the existing empty-state for the no-rollout case? (Default:
  show them as system rows when a rollout exists alongside; empty-state still
  governs the no-rollout case.)
