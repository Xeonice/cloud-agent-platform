# Research Brief — configurable-task-slots

Side-car research (not a tracked artifact). Synthesized from a three-route
research fan-out — Web (industry precedent), Codebase (direct file reads),
Archive (prior OpenSpec changes). Every claim carries its source anchor.

Pre-made operator decisions (treat as RESOLVED, do not relitigate):

1. **Shrink = no-kick.** Lowering the ceiling only stops back-filling; running
   tasks converge naturally as they release.
2. **One global pool.** The slot ceiling is system-wide, not per-user.
3. **DB overrides env.** The persisted setting wins over
   `MAX_CONCURRENT_TASKS`; env is the first-boot default. Raising the ceiling
   promotes queued tasks immediately.
4. **Restart re-offer.** On startup, DB `queued` tasks are re-offered to the
   semaphore in `createdAt` ascending order.

---

## Route: Web — industry precedent

### W1. p-queue's `concurrency` setter is the implementation template

The setter validates `typeof n === 'number' && n >= 1` (else TypeError),
assigns, then immediately calls `this.#processQueue()` — raising the limit
promotes queued work at once; lowering only changes the number and lets
running work converge without interruption.

> `set concurrency(newConcurrency) { if (!(typeof newConcurrency === 'number' && newConcurrency >= 1)) throw new TypeError(...); this.#concurrency = newConcurrency; this.#processQueue(); }`

- Evidence: https://github.com/sindresorhus/p-queue/blob/main/source/index.ts (concurrency setter)
- Relevance: direct template for `ConcurrencySemaphore.setMaxConcurrentTasks` —
  validate positive integer, assign, loop `admitNext()` until the new ceiling
  is filled. Matches decisions 1/3 verbatim and proves no eviction logic is
  needed for correct convergence.

### W2. BullMQ: runtime-mutable worker concurrency + store-backed global ceiling

Worker-level `worker.concurrency = N` is documented as updatable while
running; queue-level `await queue.setGlobalConcurrency(4)` persists the global
value in Redis (queue metadata), independent of any worker process, and worker
concurrency never exceeds it.

- Evidence: https://docs.bullmq.io/guide/workers/concurrency ;
  https://docs.bullmq.io/guide/queues/global-concurrency
- Relevance: mature-system endorsement of "one shared global pool + value in a
  persistent store, not process memory/env" — the store-backed global ceiling
  is the industry analogue of decision 2/3 (DB setting survives restarts and
  overrides env).

### W3. CI runners: live-reload concurrency, new value only gates future pickup

GitLab Runner's global `concurrent` reloads from config.toml every 3 seconds
(and on SIGHUP) without restart; the new value constrains only subsequent job
pickup — running jobs are untouched. Jenkins node executor counts behave the
same way.

- Evidence: https://docs.gitlab.com/runner/configuration/advanced-configuration/
  (config reload every 3s, no restart needed except `listen_address`)
- Relevance: CI runners are the closest competitor shape to this platform's
  task slots; they uniformly implement "change takes effect immediately, only
  affects new scheduling, never kicks running jobs" — decision 1 is industry
  standard, not a compromise.

### W4. AdjustableSemaphore: the lazy-decrease pattern has a mature precedent

Java's AdjustableSemaphore (addthis/basis) subclasses
`Semaphore.reducePermits()` — on shrink, current holders are neither notified
nor interrupted; subsequent acquires block until outstanding drops below the
new limit. Grow = release the delta of permits (which wakes waiters).

- Evidence: https://github.com/addthis/basis/blob/master/basis-core/src/main/java/com/addthis/basis/util/AdjustableSemaphore.java
- Relevance: concurrency-correctness reference for the semaphore.ts setter —
  grow path is equivalent to N releases (each reusing the existing
  `admitNext` FIFO promotion); shrink path only mutates
  `_maxConcurrentTasks` and relies on the existing
  `release() → admitNext()` `running < max` check to converge. No new
  eviction code.

### W5. DB-backed queues treat the database as the single source of truth at startup

Rails Solid Queue's supervisor prunes dead-heartbeat processes and releases
their claimed executions (freeing concurrency locks, unblocking waiters back
to ready); graphile-worker returns crash-locked jobs to the pool via
timeout/heartbeat; pg-boss keeps all queued jobs as Postgres rows and resumes
via `SKIP LOCKED` after restart. "In-memory queue + restart stranding" is
treated as a defect and systematically fixed in all of them.

- Evidence: https://deepwiki.com/rails/solid_queue/7.3-process-failure-and-recovery ;
  https://worker.graphile.org/docs/pro/recovery
- Relevance: supports change point 4 (re-offer DB `queued` tasks at startup in
  `createdAt` asc order). `reclaimOrphanedOnStartup` should grow into a dual
  responsibility — reclaim `running`/`awaiting_input` AND re-enqueue `queued` —
  isomorphic to Solid Queue's supervisor sequence (prune first, then restore
  scheduling).

### W6. Per-task timeout params belong on the job row, not in memory

pg-boss persists `expireInSeconds` (max active duration — a deadline
equivalent) and `retentionSeconds` on the job row; BullMQ persists job opts
(including timeout-class params) with the job in Redis. No mainstream system
accepts "timeout params lost on restart".

- Evidence: https://github.com/timgit/pg-boss (expireInSeconds per-job option) ;
  https://logsnag.com/blog/deep-dive-into-background-jobs-with-pg-boss-and-typescript
- Relevance: answers the "persist pendingGuardrails?" research question from
  the industry side — persist, don't accept loss. (Codebase route C2 shows
  the columns already exist, so no new work is even needed.)

### W7. Instance-level settings live in a system singleton table, env is only a seed

GitLab stores instance-wide settings in the single-row `application_settings`
table (Admin Area + `/api/v4/application/settings`), with env vars only as
default sources and the DB value authoritative. The generic single-row pattern
uses a fixed primary key (e.g. `id=1` + CHECK constraint) + upsert to enforce
the singleton.

- Evidence: https://docs.gitlab.com/administration/settings/ ;
  https://docs.gitlab.com/api/settings/ ;
  https://dev.to/wildgeodude/application-config-in-a-single-row-table-4lbj
- Relevance: answers "where does the setting live" — NOT in per-user
  `AccountSettings` (userId-unique semantics misfit; ambiguous whose value
  wins under multi-user). Precedent points to a new SystemSettings single-row
  table (fixed id + upsert) with env `MAX_CONCURRENT_TASKS` as the seed when
  no row exists — exactly decisions 2/3.

### W8. Default/range calibration: small single digits, hard floor of 1

Drone runner `DRONE_RUNNER_CAPACITY` defaults to 2; GitLab Runner `concurrent`
defaults to 1; this project currently defaults to 5. Competitor cloud-agent
platforms (GitHub Copilot coding agent) allow concurrent sessions but cap them
platform-side without exposing the knob.

- Evidence: https://docs.drone.io/runner/docker/configuration/reference/drone-runner-capacity/ ;
  https://docs.github.com/en/copilot/concepts/agents/cloud-agent/agent-management
- Relevance: validation range 1–20 with default 5 is consistent with industry
  magnitude (20 is already generous for a single-host sandbox platform). Floor
  MUST be ≥1 (p-queue enforces the same; 0 would permanently starve the
  queue). Zod: `z.number().int().min(1).max(20).default(5)`.

### W9. NestJS propagation: direct injection when acyclic, events only as a decoupling fallback

NestJS officially recommends `@nestjs/event-emitter` for cross-module runtime
config propagation when imports would cycle (settings emits
`settings.updated`, guardrails subscribes via `@OnEvent`). But if the
dependency direction is already one-way (settings → guardrails, no cycle),
direct injection of GuardrailsService with a synchronous call is the simpler
same-process option.

- Evidence: https://docs.nestjs.com/techniques/events
- Relevance: answers "how does the update reach GuardrailsService" — decided
  by whether the module import graph cycles. Codebase route C7 confirms it is
  acyclic, so direct synchronous call wins (easier to test, unambiguous
  immediate-effect semantics matching decision 3).

### W10. Avoid read-path caching pitfalls by going pure-push

GitLab application settings are cached for 60 seconds before fully taking
effect — a known trap of DB-backed settings: per-request DB reads need a
cache, and the cache delays effect. This change can bypass the read path
entirely: load once from DB at startup, then push new values from the write
path (settings save) directly into the semaphore.

- Evidence: https://docs.gitlab.com/administration/settings/ (settings cached
  for 60 seconds)
- Relevance: design hint — never query the DB for the ceiling on the
  `offer()` hot path. Keep `_maxConcurrentTasks` as the in-memory
  authoritative value, written only at "bootstrap load" and "settings update
  push". Satisfies both performance and immediate effect.

---

## Route: Codebase — current-state facts

### C1. The change directory already exists as a stub

`openspec/changes/configurable-task-slots/` contains only `.openspec.yaml`
(schema: spec-driven, created 2026-06-10) — no proposal/specs/tasks yet.

- Evidence: `/Users/tanghehui/ExploreProject/cloud-agent-platform/openspec/changes/configurable-task-slots/.openspec.yaml`
- Relevance: generate artifacts into this directory; do not create a second
  change folder.

### C2. Guardrail params are ALREADY persisted on the Task row

`idle_timeout_ms` (`schema.prisma:104`) and `deadline_ms` (`schema.prisma:109`)
were added by migration `20260609010000_add_task_guardrail_controls`;
`create()` writes them (`tasks.service.ts:159-160`) and `toResponse` echoes
them (`tasks.service.ts:401-402`).

- Evidence: `apps/api/prisma/schema.prisma:104,109`;
  `apps/api/prisma/migrations/20260609010000_add_task_guardrail_controls/migration.sql`
- Relevance: restart recovery needs NO new columns — queued tasks'
  `pendingGuardrails` is fully restorable from the task row at re-offer.
  `deadlineMs` is defined as "ms from admission"
  (`guardrails.service.ts:124-125`, armed via `deadlines.armAfter` at
  `startRunning` `:400-402`), so re-arming at re-admission after restart is
  semantically well-defined.

### C3. The permanent-stranding defect is confirmed in reclaimOrphanedOnStartup

`TasksService.onApplicationBootstrap` queries only
`status in ['running','awaiting_input']` and fails them; `queued` tasks are
untouched and the in-memory semaphore is never rehydrated.

- Evidence: `apps/api/src/tasks/tasks.service.ts:102-126` (where clause at `:104`)
- Relevance: the fix point — after reclaim, re-offer DB queued tasks ordered
  by `createdAt asc` (orderBy pattern at `tasks.service.ts:203-205`) via
  `guardrails.admit(id, {deadlineMs, idleTimeoutMs})` read from each row.
  Lifecycle permits queued→running (`task-lifecycle.ts:45`) and `admit()`'s
  `safeTransition` swallows the no-op queued→queued edge for tasks that stay
  queued.

### C4. NestJS lifecycle ordering makes startup re-offer safe

`GuardrailsService.onModuleInit` resolves TasksService
(`guardrails.service.ts:247-258`) and all `onModuleInit` hooks run before any
`onApplicationBootstrap`, where the existing reclaim lives
(`tasks.service.ts:90-92`). `AioSandboxProvider.onApplicationBootstrap`
independently reaps all `cap-aio-*` containers at boot
(`aio-sandbox.provider.ts:247-282`, commit 0f62608).

- Evidence: `apps/api/src/guardrails/guardrails.service.ts:247-258`;
  `apps/api/src/sandbox/aio-sandbox.provider.ts:247-282`; git commit 0f62608
- Relevance: re-offer must run at `onApplicationBootstrap` AFTER loading the
  DB ceiling override; queued tasks have no sandbox, so the container reaper
  never conflicts with them. Commit 0f62608 is the direct precedent for
  startup-reclaim behavior — currently unspecified in any spec, so a new
  requirement is needed.

### C5. Semaphore internals: where the setter goes

`ConcurrencySemaphore._maxConcurrentTasks` is `private readonly`
(`semaphore.ts:35,51`) with only a getter (`:60-62`); the constructor
validates positive integer (`:44-50`); `hasCapacity = running.size < max`
(`:75-77`); `release()` admits at most ONE queued task (`:127-139`); and
`admitNext()` is private (`:146-159`).

- Evidence: `apps/api/src/guardrails/semaphore.ts:35,44-50,60-62,75-77,127-159`
- Relevance: add `setMaxConcurrentTasks(n)` that re-validates and, when
  RAISED, loops `admitNext()` until capacity or queue exhausts (decision 3:
  immediate promotion). When LOWERED, `hasCapacity` going false already
  implements decision 1 (stop back-filling, natural convergence) with zero
  eviction code — `running.size > max` is tolerated until releases catch up.

### C6. Today's ceiling source: env read once at module construction

The ceiling comes only from `process.env.MAX_CONCURRENT_TASKS` read at module
construction (`guardrails.module.ts:69-72`, `readPositiveInt` `:87-91`),
falling back to `DEFAULT_GUARDRAILS_CONFIG.maxConcurrentTasks = 5`
(`guardrails.service.ts:109-110`); `.env.example` documents it commented at 5
(`:37`).

- Evidence: `apps/api/src/guardrails/guardrails.module.ts:67-91`;
  `apps/api/src/guardrails/guardrails.service.ts:109-116`; `.env.example:37`
- Relevance: decision 3 (DB overrides env; env = first-boot default) maps to:
  keep `readGuardrailsConfig` as the constructor seed, then a bootstrap DB
  read overrides via the new setter. `readPositiveInt` is the validation
  precedent for the 1–20 positive-int rule.

### C7. Settings→Guardrails wiring is acyclic — direct injection works

`SettingsModule` is imported only by `app.module.ts` (`:14,:60`) and itself
imports nothing (`settings.module.ts:21-26`); `GuardrailsModule` imports only
TasksModule via `forwardRef` and exports GuardrailsService
(`guardrails.module.ts:32,62`); `MetricsModule` already imports
GuardrailsModule to inject GuardrailsService (`metrics.module.ts:30`) as the
exact precedent.

- Evidence: `apps/api/src/settings/settings.module.ts:21-26`;
  `apps/api/src/metrics/metrics.module.ts:26-30`; `apps/api/src/app.module.ts:56,60`
- Relevance: SettingsModule can import GuardrailsModule and call
  `guardrails.setMaxConcurrentTasks(n)` synchronously on save (same process,
  immediate effect) with no module cycle. PrismaModule is `@Global`
  (`prisma.module.ts:8`), so GuardrailsService can also read the persisted
  ceiling at bootstrap without new imports. (Resolves W9's branch: direct
  call, not event emitter.)

### C8. AccountSettings is strictly per-user; NO system-level table exists

`AccountSettings` has `userId @unique` (`schema.prisma:248-266`) and the
account-settings spec mandates preferences "scoped to the owning account and
SHALL NOT leak across accounts" (`spec.md:7`); no system-level/singleton table
exists anywhere in schema.prisma (full file reviewed).

- Evidence: `apps/api/prisma/schema.prisma:248-266`;
  `openspec/specs/account-settings/spec.md:7`
- Relevance: decision 2 (one global pool) conflicts with AccountSettings
  semantics — the natural home is a NEW single-row system-level table (e.g.
  SystemSettings with `maxConcurrentTasks`), and the spec delta must
  explicitly model it as system-scoped (any allowlisted operator reads/writes
  the same value), distinct from per-account prefs.

### C9. Contracts: no slot field anywhere; RetentionDaysSchema is the constraint precedent

`AccountSettingsSchema` (`settings.ts:51-61`) and
`UpdateSettingsRequestSchema` (`:133-141`) have no slot field;
`RetentionDaysSchema` (`:31-36`) is the precedent for constraining a numeric
setting to an allowed range/set in zod.

- Evidence: `packages/contracts/src/settings.ts:31-36,51-61,133-141`
- Relevance: add the new contract shape — e.g.
  `z.number().int().min(1).max(20)` default 5 — following the RetentionDays
  precedent; decide whether to extend existing settings shapes or add a
  separate system-settings schema given the per-account vs system-level split.

### C10. Settings REST surface pattern to mirror

GET/PATCH/PUT `/settings` with `ZodValidationPipe` on the contracts schema,
per-account scoping via `requireOperator`
(`settings.controller.ts:78-101,167-180`); `SettingsService.updateSettings`
validates, upserts, and returns the sanitized read shape
(`settings.service.ts:98-152`).

- Evidence: `apps/api/src/settings/settings.controller.ts:78-101`;
  `apps/api/src/settings/settings.service.ts:98-152`
- Relevance: the slot setting can ride the same endpoints (new optional field
  on UpdateSettingsRequest) or a sibling route; "invalid body mutates
  nothing" and read-back-after-write semantics are established requirements
  to mirror. Pure-logic helpers live in `settings-logic.ts` with
  `settings-logic.test.mjs` as the unit-test pattern.

### C11. Metrics propagate automatically — but shrink-overage breaks a spec invariant

`/metrics` reads `semaphore.maxConcurrentTasks` live per request
(`metrics-projection.ts:57`) through the delegating SemaphoreProjectionSource
getters (`guardrails.service.ts:581-596`); `projectCapacity` clamps `free` at
0 (`:61`) and `buildSlotOccupancy` lists exactly `ceiling` slots, dropping
surplus running ids (`:87-104`).

- Evidence: `apps/api/src/metrics/metrics-projection.ts:54-104`;
  `apps/api/src/guardrails/guardrails.service.ts:581-596`
- Relevance: no metrics code change strictly needed, BUT during
  shrink-convergence (`running > new ceiling`) the resource-metrics spec
  invariants "active + free === ceiling" and "busy entries === active"
  (`specs/resource-metrics/spec.md:8,30`) break — the projection already
  clamps defensively, so the spec delta should add a transitional-overage
  clause rather than new code.

### C12. Spec coverage gap: ceiling requirement is env-phrased; startup recovery unspecced

The guardrails requirement "Concurrency semaphore bounds running tasks" is
written purely in terms of configured `MAX_CONCURRENT_TASKS`
(`specs/guardrails/spec.md:6-15`); no spec anywhere covers startup reclaim or
queued-task restart recovery (grep across openspec/specs found none).

- Evidence: `openspec/specs/guardrails/spec.md:6-15`
- Relevance: delta scope — MODIFY this requirement (DB-over-env precedence,
  runtime mutability, shrink = stop-backfilling, grow = immediate FIFO
  promotion) and ADD a new requirement for startup recovery (failed reclaim
  of running/awaiting_input + FIFO re-offer of queued with persisted
  deadlineMs/idleTimeoutMs). account-settings and resource-metrics get
  wording deltas; frontend-console dashboard/capacity wording (`spec.md:79`)
  mentions the capacity aside.

### C13. Frontend settings form + mutation pattern to follow

`settings-form.tsx` seeds a useState draft from server-hydrated settings with
a re-seed useEffect (`:99-115`), client-validates then calls
`onSave(UpdateSettingsRequest)` (`:122-131`), with a DEFAULTS const for
恢复默认 (`:60-64`); `saveSettingsMutation` does `real.saveSettings` when
`isCapable('settings')` and invalidates settings+repos query keys
(`mutations.ts:167-195`); capability flags `settings:true` and `metrics:true`
are already live (`capabilities.ts:76,78`).

- Evidence: `apps/web/src/components/settings/settings-form.tsx:60-131`;
  `apps/web/src/lib/api/mutations.ts:167-195`
- Relevance: the new number field follows this exact mutation/draft/validation
  pattern; retention's Select-over-allowed-set is the in-form numeric control
  precedent. For "raise takes effect immediately" in the UI, onSuccess should
  ALSO invalidate `queryKeys.metrics` — metricsQuery only polls every 5s
  (`queries.ts:104-110`), as does capacityQuery (`:133-139`).

### C14. Mock/visual drift: CEILING=10 vs backend 5, and a hardcoded 10-column slot grid

`mock.ts` hardcodes `CEILING = 10` / `ACTIVE = 7` / `QUEUE_DEPTH = 11` in
mockMetrics (`:277-318`) while the backend default is 5; the dashboard slot
grid hardcodes `grid-cols-10` (`capacity-aside.tsx:188`) and ceiling captions
render at `capacity-aside.tsx:137,178`, `dashboard.tsx:152`,
`workspace.tsx:110`.

- Evidence: `apps/web/src/lib/api/mock.ts:277-318`;
  `apps/web/src/components/dashboard/capacity-aside.tsx:137,178,188`
- Relevance: once the ceiling is user-configurable 1–20, grid columns should
  derive from `occupancy.slots.length` (or cap visual columns), and
  `mockSettings` (`mock.ts:480-489`) + the local store DEFAULT_STATE need the
  new field for the mock path.

### C15. pendingGuardrails is the only restart-fragile state — and it's trivially restorable

`pendingGuardrails` is a pure in-memory Map stashed at `admit()` for queued
tasks and consumed at onAdmit promotion
(`guardrails.service.ts:172,266-279,379-385`), cleared in `clearTimers`
(`:491`).

- Evidence: `apps/api/src/guardrails/guardrails.service.ts:159-172,266-279,379-385`
- Relevance: because Task rows persist the same params (C2), the startup
  re-offer path simply re-populates this Map via
  `admit(id, {deadlineMs, idleTimeoutMs})` from the DB — no persistence
  redesign of pendingGuardrails itself is required.

### C16. Test convention: colocated plain-node .mjs tests

Guardrails has `semaphore.test.mjs`, `idle-tracker.test.mjs`,
`circuit-breaker.test.mjs`, `guardrails-exit-roundtrip.test.mjs`; settings has
`settings-logic.test.mjs` / `settings-crypto.test.mjs`.

- Evidence: `apps/api/src/guardrails/` (ls); `apps/api/src/settings/` (ls)
- Relevance: new tests (setter promotion loop, shrink no-eviction convergence,
  startup queued re-offer with param restore, settings validation 1–20)
  follow this colocated .mjs pattern.

---

## Route: Archive — prior-change precedent

### A1. task-guardrail-controls is the structural template

`archive/2026-06-09-task-guardrail-controls` is the closest precedent: same
guardrails subsystem, full artifact set (.openspec.yaml `schema: spec-driven`,
proposal.md with Why/What Changes/Capabilities New+Modified/Impact, design.md
with Context/Goals-NonGoals/Decisions D1–D8 each carrying an "Alternative
rejected", Risks with mitigations, Migration Plan with rollback, Open
Questions, side-car research-brief.md with file:line anchors, track-annotated
tasks.md, per-capability spec deltas).

- Evidence: `openspec/changes/archive/2026-06-09-task-guardrail-controls/{proposal.md,design.md,tasks.md,research-brief.md}`
- Relevance: reuse this exact artifact shape and tone — it is the house style
  for guardrails changes and passed verify/archive.

### A2. Design D1 is the template for the env-vs-DB precedence decision

task-guardrail-controls D1: per-task `idleTimeoutMs` overrides operator env
`MAX_IDLE_MS`, env kept only as a fallback default, with the rejected
alternative ("drop the env entirely") recorded. Decision 3 here is the same
shape one level up.

- Evidence: `archive/2026-06-09-task-guardrail-controls/design.md` (D1, lines 40-50)
- Relevance: copy the D1 pattern — state the effective-value formula
  (`dbSetting ?? envDefault ?? 5`), why env stays, and the rejected
  alternative. The verify gate expects decisions written this way.

### A3. Guardrail-param persistence already shipped (corroborates C2)

`idleTimeoutMs Int? @map("idle_timeout_ms")` and
`deadlineMs Int? @map("deadline_ms")` were added by task-guardrail-controls D6
and hand-written migration `20260609010000_add_task_guardrail_controls`;
confirmed live at `schema.prisma:104,109`.

- Evidence: `apps/api/prisma/schema.prisma:104,109`;
  `archive/2026-06-09-task-guardrail-controls/tasks.md` tasks 2.2-2.3
- Relevance: resolves the research question under decision 4 — restart
  re-offer fully restores pendingGuardrails from the task row. No new
  columns, no "accept loss" branch.

### A4. Startup recovery is entirely unspecced today

Grep for restart/startup/orphan/reclaim across guardrails and
repo-and-task-management specs finds only idle-reclaim wording; even the
current `reclaimOrphanedOnStartup` (running/awaiting_input → failed) behavior
is unspecced.

- Evidence: grep over `openspec/specs/guardrails/spec.md` and
  `specs/repo-and-task-management/spec.md` (no restart/startup requirement)
- Relevance: the queued-task restart re-offer is an ADDED requirement (no
  verbatim-copy MODIFIED header to anchor to); decide whether to also spec
  the existing running/awaiting_input reclaim while in there or leave it
  implicit.

### A5. The guardrails requirement to MODIFY, and the house delta style

The requirement is "Concurrency semaphore bounds running tasks"
(`spec.md:7`): it hard-names `MAX_CONCURRENT_TASKS` as THE configured maximum
and already specs FIFO admit-on-release. task-guardrail-controls shows the
house delta style: MODIFIED Requirements re-stated verbatim-by-header plus
WHEN/THEN scenarios.

- Evidence: `openspec/specs/guardrails/spec.md:7-15`;
  `archive/2026-06-09-task-guardrail-controls/specs/guardrails/spec.md`
- Relevance: delta scope — MODIFY this one requirement (ceiling source = DB
  setting over env, shrink = stop-admitting-only, grow = immediate promotion)
  and ADD scenarios for resize semantics; FIFO wording can stay.

### A6. resource-metrics references the ceiling source; multi-target-deploy does NOT need a delta

`specs/resource-metrics/spec.md:8` says "the configured slot ceiling
(`maxConcurrentTasks`, equivalently `MAX_CONCURRENT_TASKS`)" and the slot
table "SHALL list exactly maxConcurrentTasks slots". The spec was created by
rebuild-console-tanstack-start and twice modified by small surgical MODIFIED
deltas.

- Evidence: `openspec/specs/resource-metrics/spec.md:8,30`;
  `archive/2026-06-09-console-task-metrics-and-navigation/specs/resource-metrics/spec.md`
- Relevance: the "equivalently MAX_CONCURRENT_TASKS" parenthetical goes stale
  once DB overrides env — include a minimal resource-metrics MODIFIED delta;
  the live-semaphore projection wording otherwise already tolerates a dynamic
  ceiling. `multi-target-deploy spec.md:15,34` (compose passes
  MAX_CONCURRENT_TASKS) stays valid since env remains the bootstrap default —
  do NOT over-delta it.

### A7. The settings-field-addition recipe

`archive/2026-06-06-rebuild-console-tanstack-start`: task 1.7 (contracts
settings.ts schema), Track 7 be-account-settings (read API returns
defaults-when-unsaved; update API validates against contracts, rejects
invalid body 400 without mutating, rejects writes to read-only fields), Track
14 (settings form + saveSettingsMutation + invalidate settingsQuery). It also
created the account-settings spec.

- Evidence: `archive/2026-06-06-rebuild-console-tanstack-start/tasks.md:14,64-72,130-137`
  and `specs/account-settings/spec.md`
- Relevance: reuse the contracts → settings-service → settings-form track
  ordering and the "constrained range, invalid body mutates nothing"
  validation wording for the 1–20 slot field (mirrors the retention
  7/30/90/180 constraint pattern).

### A8. The per-account vs global tension must be resolved explicitly

`AccountSettings` is strictly per-user (Prisma `userId String @unique`,
`schema.prisma:248-264`) and the account-settings spec requires "Preferences
SHALL be scoped to the owning account and SHALL NOT leak across accounts"
(`spec.md:7`). A global shared slot ceiling stored there violates that
requirement's semantics — and no system-level/singleton settings precedent
exists anywhere in the archive.

- Evidence: `apps/api/prisma/schema.prisma:248-264`;
  `openspec/specs/account-settings/spec.md:7`
- Relevance: the proposal must take a position (e.g. new system-settings
  single-row table, or an ADDED "system-level setting" requirement carving an
  explicit exception in account-settings) rather than silently dropping a
  global value into the per-account row — the leak-scoping scenario would
  otherwise fail verify.

### A9. How to record pre-made operator decisions

close-aio-execution-gaps wrote the operator's pick directly into proposal.md
as "DECIDED -> (c)" with all candidate options enumerated and pointed at
design.md D2; task-guardrail-controls marks decisions with
"(operator decision: ...)" in the research brief.

- Evidence: `archive/2026-06-09-close-aio-execution-gaps/proposal.md` (Gap A block);
  `archive/2026-06-09-task-guardrail-controls/research-brief.md:23`
- Relevance: record the four pre-made decisions (no-kick shrink, global pool,
  DB-over-env with immediate promotion, restart re-offer) as RESOLVED
  decisions with the rejected alternatives named, so research/apply agents do
  not relitigate them.

### A10. tasks.md house convention

Numbered parallel Tracks with explicit `depends:` headers (contracts →
db-schema → guardrails → api-lifecycle → web → verify-and-docs), each task
naming exact file paths and recording test counts on completion; final track
always includes static gates (tsc/eslint/vitest), docs (.env.example), and a
no-debugger grep — matching the user's global commit rule.

- Evidence: `archive/2026-06-09-task-guardrail-controls/tasks.md:1-52`
- Relevance: reuse the same track partition — it cleanly maps to: contracts
  (settings schema field), db (settings storage), guardrails (semaphore
  setMax + resize + startup re-offer), api (settings service → guardrails
  wiring), web (settings form + mock CEILING), verify-docs.

### A11. Frontend mock mismatch corroborated (see C14)

`apps/web/src/lib/api/mock.ts:277` `const CEILING = 10` drives mock
slots/free, while the backend default is 5. The settings form already follows
the settingsQuery + saveSettingsMutation paradigm (`settings-form.tsx` doc
comments).

- Evidence: `apps/web/src/lib/api/mock.ts:277,314`;
  `apps/web/src/components/settings/settings-form.tsx:13-15,79`
- Relevance: the web track needs a small task aligning mock CEILING with the
  new default/dynamic value and adding the numeric slot field through the
  existing mutation/invalidate pattern.

### A12. Things to avoid (verify hygiene)

(1) verification-report.md is NOT authored at propose time — only
agent-control-platform and demo-workflow-smoketest carry one, produced later
by opsx-verify. (2) Do not bundle unrelated capability deltas — every
archived change keeps deltas to only the capabilities it truly modifies
(task-guardrail-controls explicitly justified NOT touching audit-history in a
proposal note). (3) Migrations are hand-written SQL (no local DB), mirroring
20260609010000 — do not assume `prisma migrate dev`.

- Evidence: find over archive (verification-report.md only in
  2026-06-03-agent-control-platform and 2026-06-09-demo-workflow-smoketest);
  `archive/2026-06-09-task-guardrail-controls/proposal.md` note on
  audit-history; tasks.md task 2.3
- Relevance: keeps the new change verify-clean. Expected delta set: guardrails
  (MODIFIED+ADDED), account-settings (MODIFIED or ADDED system-setting),
  resource-metrics (small MODIFIED), frontend-console (settings form
  MODIFIED) — with an explicit "not modified" note for
  multi-target-deploy/audit-history if challenged.

---

## Implications for the proposal

### 1. Storage: a NEW system-level single-row settings home, not AccountSettings

All three routes converge: AccountSettings' `userId @unique` + "SHALL NOT
leak across accounts" semantics (C8, A8) make it the wrong home for a global
pool (decision 2), and GitLab's `application_settings` single-row pattern
(W7) is the industry shape. Propose a SystemSettings single-row table (fixed
id + upsert) holding `maxConcurrentTasks`, seeded from env on first boot.
The proposal MUST take this position explicitly — silently riding the
per-account row would fail verify against the account-settings leak-scoping
scenario.

### 2. Semaphore: one setter, zero eviction code

`setMaxConcurrentTasks(n)` on `ConcurrencySemaphore` mirrors p-queue's setter
(W1) and AdjustableSemaphore's lazy decrease (W4): validate positive int
(reuse the constructor/`readPositiveInt` precedent — C5, C6), assign, and on
RAISE loop the existing private `admitNext()` until capacity or queue
exhausts. On LOWER, do nothing else — `hasCapacity` going false already stops
back-filling and `running.size > max` converges naturally (decisions 1/3,
validated by GitLab Runner/Jenkins behavior, W3). `_maxConcurrentTasks` loses
`readonly`.

### 3. Precedence and propagation: DB-over-env, push not poll

Effective value = `dbSetting ?? envDefault ?? 5` (A2's D1 formula shape).
Keep `readGuardrailsConfig` as the constructor seed; at
`onApplicationBootstrap` read the DB row and override via the setter (C6).
On settings save, SettingsModule imports GuardrailsModule and calls
`setMaxConcurrentTasks` synchronously — the import graph is acyclic (C7), so
no event emitter is needed (W9). Never read the DB on the `offer()` hot path;
in-memory value stays authoritative, written only at bootstrap-load and
settings-push (W10). env `MAX_CONCURRENT_TASKS` stays documented as the
first-boot default, so multi-target-deploy needs NO delta (A6).

### 4. Startup recovery: extend reclaim into a two-phase bootstrap requirement

After the existing running/awaiting_input → failed reclaim (C3), re-offer DB
`queued` tasks in `createdAt asc` order via
`admit(id, {deadlineMs, idleTimeoutMs})` read from each row — possible with
ZERO new columns because task-guardrail-controls already persisted both
params (C2, A3), matching the universal industry stance that timeout params
live on the job row (W5, W6). pendingGuardrails needs no persistence redesign
(C15). Ordering constraint: re-offer runs at `onApplicationBootstrap` AFTER
the DB ceiling override is loaded (C4). This is an ADDED guardrails
requirement (startup recovery is entirely unspecced today — C12, A4);
consider speccing the existing orphan reclaim in the same requirement.

### 5. Contracts and API: 1–20 int field via the established settings pipeline

Zod shape `z.number().int().min(1).max(20).default(5)` — range calibrated
against Drone/GitLab defaults (W8), floor ≥1 mandatory (0 starves the queue),
following the RetentionDaysSchema constraint precedent (C9). Ride the
existing GET/PATCH settings surface or a sibling system-settings route, with
"invalid body mutates nothing" + read-back-after-write semantics (C10, A7).
Decide in design whether the contract extends AccountSettings shapes or is a
separate system-settings schema (follows from implication 1).

### 6. Metrics: no code change, one spec clause

The projection already reads the live semaphore ceiling per request and
clamps defensively (C11), so dynamic resize propagates for free. But during
shrink-convergence the resource-metrics invariants "active + free ===
ceiling" / "busy === active" temporarily break — add a transitional-overage
clause to the spec rather than code. Also fix the stale "equivalently
MAX_CONCURRENT_TASKS" parenthetical with a minimal MODIFIED delta (A6).

### 7. Web: settings field + mock/grid alignment

New numeric field through the settings-form draft/validate/onSave +
saveSettingsMutation pattern; onSuccess should additionally invalidate
`queryKeys.metrics` so a raised ceiling shows before the 5s poll (C13). Align
mock `CEILING = 10` with the real default 5 and add the field to mockSettings
/ local-store DEFAULT_STATE (C14, A11). Derive the dashboard slot grid
columns from `occupancy.slots.length` instead of hardcoded `grid-cols-10`
once the ceiling spans 1–20 (C14).

### 8. Spec delta set (expected by verify)

- **guardrails**: MODIFY "Concurrency semaphore bounds running tasks"
  (DB-over-env ceiling source, runtime mutability, shrink/grow semantics) +
  ADD startup-recovery requirement (C12, A5).
- **account-settings**: MODIFIED or ADDED system-level-setting requirement
  resolving the scoping tension (A8).
- **resource-metrics**: small MODIFIED (ceiling-source wording +
  transitional-overage clause) (A6, C11).
- **frontend-console**: settings form / capacity wording MODIFIED (C12).
- Explicit "not modified" note for multi-target-deploy and audit-history
  (A6, A12). No verification-report.md at propose time; migrations are
  hand-written SQL (A12).

### 9. Artifact mechanics

Write all artifacts into the existing
`openspec/changes/configurable-task-slots/` stub (C1, A13-style dedup); copy
the task-guardrail-controls artifact shape and tone (A1), record the four
operator decisions as RESOLVED with rejected alternatives named (A9), and
partition tasks.md into the house track order: contracts → db → guardrails →
api → web → verify-docs with static gates and a no-debugger grep in the final
track (A10, C16 for test placement).
