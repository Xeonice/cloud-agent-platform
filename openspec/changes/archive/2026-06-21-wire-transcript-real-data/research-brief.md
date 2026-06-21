# Research Brief — wire-transcript-real-data

Side-car research notes grounding the proposal. Not a tracked artifact.

## Problem (verified in code)

The route reached by the history page's 「查看会话」 link —
`/tasks/$taskId/transcript`
(`apps/web/src/routes/_app/tasks/$taskId_.transcript.tsx`) — renders entirely
off a hardcoded `SAMPLE` constant. The component:

- never reads `taskId` from params to fetch anything (the only use of `taskId`
  is the bottom "终端记录" link's params);
- issues NO query — title `task_aaaa`, prompt, the 10 events are all literal.

The file header admits it: *"a constant sample transcript (the live read lands
with the persisted-transcript wiring, design D7)"* — wiring deferred in
`pixel-restore-console-to-od` Track 11 and never done.

## The real implementation already exists — on a different route

`GET /tasks/:id/session-history` is live (`session-history-replay`,
`session-transcript-persistence`) and returns a parsed, durable-first transcript
(`@cap/contracts` `SessionHistory`). It is consumed by the `SessionReplay`
component (`apps/web/src/components/session/session-replay.tsx`), mounted on
`/tasks/$taskId` for FINISHED tasks (sidebar + conversation pane, conv/term
tabs, search + 5 filter presets, empty/expired/interrupted states).

So there are TWO transcript UIs: route A (`/tasks/:id`, REAL) and route B
(`/tasks/:id/transcript`, 100% MOCK — the history link's actual target). The
mock page's "终端记录" button even links back to route A.

## Field-availability audit (against the rollout source, not just the contract)

Raw rollout line is `{timestamp, type, payload}`
(`apps/api/src/sandbox/rollout-parser.ts`).

| transcript.html element | source availability | tier |
| --- | --- | --- |
| user / commentary("推理") / final answer / tool timeline | already parsed | 0 |
| per-turn timestamp (time gutter) | **`line.timestamp` IS in source**, parser drops it (only `session_meta` uses it) | 1 |
| header total tokens / duration | derivable: sum `token_count` deltas; `startedAt`..last line ts | 1 |
| tool diffstat (+N/−M) | derivable: apply_patch turn's `args` is the full patch text — count +/- lines | 2 |
| system milestones (沙箱就绪·分配 / 任务创建 / 完成) | **NOT in rollout** — cross-source | 3 |

Correction to an earlier read: per-turn timestamps are NOT missing; the source
carries them, the parser discards them. So the timeline gutter is a cheap add,
not a blocker.

## TIER 3 cross-source = `AuditEvent` table

`apps/api/prisma/schema.prisma` `model AuditEvent`:
- `type` ∈ `task.created` / `task.running` / `task.completed` / `task.failed` /
  `task.cancelled` / `agent_failed_to_start` / `force_failed`;
- carries `taskId`, `title`, `description`, `timestamp`, `resultCode`, `runId`;
- `@@index([taskId, timestamp])` — fetch a task's lifecycle in time order.

Merge by timestamp with the rollout-derived turns (TIER 1 timestamps make the
merge well-ordered). Note: there is no `sandbox.allocated`/node-id audit type, so
the exact mock text "已分配 iad-02-01" has no 1:1 source — degrade to the
available milestone titles (created / running≈沙箱就绪 / completed/failed/
cancelled); never fabricate a node id.

## Serialization surface (blast radius of a contract field)

```
packages/contracts/src/session-history.ts   ← single zod source (additive optional fields)
apps/api/src/sandbox/rollout-parser.ts        ← populate per-turn ts / diffstat / totals
apps/api/src/tasks/session-history.controller.ts + session-transcript.service.ts
                                              ← durable-first + AuditEvent merge
apps/api/src/v1/v1-transcript.controller.ts   ⚠ public /v1 also serializes turns → additive OpenAPI
apps/web/src/lib/api/real.ts                  ← just SessionHistorySchema.parse (auto-flows)
apps/web/src/lib/api/mock.ts                  ← mock must produce new fields
apps/web/src/routes/_app/tasks/$taskId_.transcript.tsx ← consume real query (delete SAMPLE)
```

Two durability wrinkles:
1. **Durable archive** (`SessionTranscript`): historical tasks were parsed under
   the OLD schema; new fields must be additive-optional and degrade gracefully
   when an old archive lacks them (re-parse only possible if the container is
   still retained).
2. **Public v1 contract**: `/v1/tasks/:id/transcript` gains additive fields →
   OpenAPI snapshot must be regenerated.

## Verification map (existing conventions)

- Backend `.test.mjs` (tsc-compile real `.ts` + `node --test` + inline assert,
  synthetic-content/real-structure fixtures):
  - `rollout-parser.test.mjs` — new fields: per-turn ts, diffstat, totals; each
    with a "source missing → honest omission" negative case.
  - `session-history.controller.test.mjs` / `session-transcript.service.test.mjs`
    — AuditEvent merge ordering; durable round-trip of new fields; old archive
    (no field) degrades.
- Frontend:
  - `mock.test.ts` — `mockSessionHistory` still validates against
    `SessionHistorySchema` with the new fields populated.
  - NEW component test (vitest) for the transcript route — the largest gap
    today (SAMPLE page has zero tests): reads `taskId`, filter+search narrow
    together, each turn kind renders, empty state.
  - `pixel.spec.ts` visual gate — the `transcript` manifest entry already exists
    (`apps/web/e2e/visual/manifest.ts`), RED until the route renders real data
    in `VITE_FORCE_MOCK` mode; needs FIXED mock timestamps for determinism +
    `VV_MEASURE` threshold calibration.
- e2e / activation — `sessionHistory` capability flag flip + live read.
