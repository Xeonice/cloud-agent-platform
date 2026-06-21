## Why

The history page's 「查看会话」 link points at `/tasks/$taskId/transcript`, but
that route renders an entirely hardcoded `SAMPLE` constant — it never reads
`taskId`, never issues a query, and shows the same fake `task_aaaa` transcript
for every task. The data wiring was deferred in `pixel-restore-console-to-od`
(Track 11, "design D7") and never landed. Meanwhile the real transcript already
exists on a different route (`GET /tasks/:id/session-history` → `SessionReplay`
on `/tasks/$taskId`), so the dedicated transcript page is a dead mock shell that
misleads operators reviewing finished work.

## What Changes

- Wire `/tasks/$taskId/transcript` to the real `sessionHistoryQuery` data,
  deleting the `SAMPLE` constant; render the transcript.html timeline (time
  gutter + typed rows) off real `SessionHistory` turns, with the existing
  filter/search/empty-state behavior driven by real data.
- Carry **per-turn timestamps** through the parse contract (the source rollout
  line already has `timestamp`; the parser currently drops it) so the timeline's
  time gutter shows real times.
- Add **header totals** to the session-history meta — total tokens (sum of the
  rollout `token_count` deltas) and session duration (first → last rollout
  timestamp).
- Add **tool diffstat** (`+N / −M`) to tool turns, derived by counting the
  added/removed lines in an `apply_patch` turn's patch text. Non-patch tools and
  malformed patches carry no diffstat (honest omission).
- Add **system milestone turns** (任务创建 / 沙箱就绪≈运行 / 任务完成·失败·取消)
  merged into the transcript stream from the `AuditEvent` table by timestamp.
  No node id is fabricated where the audit source carries none.
- Surface the additive fields on the public `GET /v1/tasks/:id/transcript`
  response and regenerate its OpenAPI document (additive, non-breaking).
- The existing `SessionReplay` renderer on `/tasks/$taskId` keeps working
  unchanged against the same (now richer) contract; new fields are
  additive-optional so historical durable archives degrade gracefully.

## Capabilities

### New Capabilities
<!-- none — this extends existing capabilities -->

### Modified Capabilities
- `session-history-replay`: the parse contract gains per-turn timestamps, tool
  diffstat, and session-level totals; the response gains audit-sourced system
  milestone turns merged by timestamp; and the dedicated `/tasks/$taskId/transcript`
  route becomes a real, data-driven renderer (replacing the hardcoded sample),
  reachable from the history 「查看会话」 link.
- `public-v1-api`: the `GET /v1/tasks/:id/transcript` response surfaces the new
  additive transcript fields (per-turn timestamp, diffstat, totals, system
  turns); the OpenAPI document is regenerated. Additive, non-breaking.

## Impact

- **Contracts**: `packages/contracts/src/session-history.ts` — additive-optional
  fields on `SessionTurn` (timestamp, diffstat), a new `system` turn kind, and
  `SessionHistoryMeta` totals.
- **API**: `apps/api/src/sandbox/rollout-parser.ts` (populate ts / diffstat /
  totals), `apps/api/src/tasks/session-history.controller.ts` +
  `session-transcript.service.ts` (merge `AuditEvent` milestones, durable-first
  preserved), `apps/api/src/v1/v1-transcript.controller.ts` + OpenAPI doc.
- **Durable archive**: `SessionTranscript` rows persisted under the old schema
  lack the new fields; the contract keeps them optional so old archives read
  back without error (re-parse only when the container is still retained).
- **Web**: `apps/web/src/routes/_app/tasks/$taskId_.transcript.tsx` (real query,
  delete SAMPLE), `apps/web/src/lib/api/mock.ts` (mock new fields),
  `real.ts` auto-flows via schema parse.
- **Tests**: `rollout-parser.test.mjs`, `session-history.controller.test.mjs`,
  `session-transcript.service.test.mjs`, `mock.test.ts`, a NEW transcript route
  component test, and the `transcript` visual-gate entry
  (`apps/web/e2e/visual/manifest.ts` / `pixel.spec.ts`).
- **Activation**: gated by the existing `sessionHistory` capability flag; live
  read verified post-deploy.
