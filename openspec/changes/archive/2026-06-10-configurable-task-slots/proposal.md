# Proposal: configurable-task-slots

## Why

The task-slot ceiling is read once from `process.env.MAX_CONCURRENT_TASKS` at module
construction (`guardrails.module.ts:67-91`) and is immutable for the process lifetime —
operators cannot tune concurrency without redeploying. Worse, a confirmed defect strands
work across restarts: `reclaimOrphanedOnStartup` (`tasks.service.ts:102-126`) only fails
`running`/`awaiting_input` tasks, while DB `queued` tasks are never re-offered to the
in-memory semaphore, leaving them queued forever. Every mature peer (BullMQ, GitLab Runner,
Solid Queue, pg-boss) treats both gaps — frozen concurrency and restart stranding — as
defects to fix.

## What Changes

Four operator decisions are pre-made and RESOLVED (do not relitigate):

1. **Shrink = no-kick.** Lowering the ceiling only stops back-filling; running tasks
   converge naturally as they release. (Rejected: evicting/killing surplus running tasks —
   no CI runner or queue library does this.)
2. **One global pool.** The ceiling is system-wide, not per-user. (Rejected: per-account
   ceilings — conflicts with a single shared semaphore and sandbox-host capacity.)
3. **DB overrides env.** The persisted setting wins; `MAX_CONCURRENT_TASKS` is only the
   first-boot seed. Raising the ceiling promotes queued tasks immediately. (Rejected:
   dropping the env var — deploy compose still needs a bootstrap default.)
4. **Restart re-offer.** On startup, DB `queued` tasks are re-offered to the semaphore in
   `createdAt` ascending order. (Rejected: accepting loss / requiring manual re-queue.)

Concrete changes:

- **Runtime-mutable semaphore.** Add `setMaxConcurrentTasks(n)` to `ConcurrencySemaphore`
  (p-queue/AdjustableSemaphore pattern): validate positive integer, assign; on raise, loop
  the existing `admitNext()` to promote queued tasks FIFO immediately; on lower, no eviction
  code — `hasCapacity` going false stops back-filling and `running.size > max` converges
  naturally.
- **Persisted system-level setting.** New single-row SystemSettings storage (fixed id +
  upsert) holding `maxConcurrentTasks`, seeded from env on first boot. Explicitly NOT in
  `AccountSettings` — its `userId @unique` scoping ("SHALL NOT leak across accounts")
  is semantically wrong for a global pool. Effective value: `dbSetting ?? envDefault ?? 5`.
- **Push propagation, no read-path cache.** Settings save calls
  `guardrails.setMaxConcurrentTasks(n)` synchronously (SettingsModule → GuardrailsModule
  import is acyclic; no event emitter). The in-memory value stays authoritative — written
  only at bootstrap load and settings push; the `offer()` hot path never queries the DB.
- **Two-phase startup recovery.** Extend bootstrap: after the existing
  running/awaiting_input → failed reclaim, load the DB ceiling override, then re-offer DB
  `queued` tasks in `createdAt asc` order via `admit(id, {deadlineMs, idleTimeoutMs})` read
  from each Task row — zero new columns, since task-guardrail-controls already persisted
  both params (`schema.prisma:104,109`).
- **Contract + API.** New settings field validated `z.number().int().min(1).max(20)`
  (default 5; floor ≥1 mandatory — 0 starves the queue; range calibrated against
  Drone/GitLab defaults), riding the established GET/PATCH settings surface with
  "invalid body mutates nothing" + read-back-after-write semantics.
- **Web console.** Numeric slot field in the settings form via the existing
  draft/validate/onSave + `saveSettingsMutation` pattern, additionally invalidating
  `queryKeys.metrics` on success; align mock `CEILING = 10` with the real default 5; derive
  the dashboard slot grid columns from `occupancy.slots.length` instead of hardcoded
  `grid-cols-10` now that the ceiling spans 1–20.
- **Metrics.** No code change — the projection already reads the live semaphore ceiling per
  request and clamps defensively. Spec-only: a transitional-overage clause for
  shrink-convergence (when `running > new ceiling`, "active + free === ceiling" /
  "busy === active" temporarily break) and removal of the stale "equivalently
  `MAX_CONCURRENT_TASKS`" wording.

No breaking changes: env `MAX_CONCURRENT_TASKS` keeps working as the first-boot default,
existing API shapes only gain an optional field, and shrink never interrupts running tasks.

## Capabilities

### New Capabilities

None — all changes land as requirement deltas to existing capabilities.

### Modified Capabilities

- `guardrails`: MODIFY "Concurrency semaphore bounds running tasks" — ceiling source
  becomes the persisted system setting with env as first-boot seed; runtime mutability with
  shrink = stop-admitting-only and grow = immediate FIFO promotion. ADD a startup-recovery
  requirement covering the existing orphan reclaim (currently unspecced) plus FIFO re-offer
  of `queued` tasks with persisted `deadlineMs`/`idleTimeoutMs` restored.
- `account-settings`: ADD a system-level-setting requirement resolving the scoping tension
  explicitly — the slot ceiling is one shared value read/written by any allowlisted
  operator, carved out from the per-account "SHALL NOT leak across accounts" rule.
- `resource-metrics`: small MODIFY — ceiling-source wording (drop the stale env
  parenthetical at `spec.md:8`) and a transitional-overage clause for shrink convergence.
- `frontend-console`: MODIFY settings-form and dashboard/capacity wording — new slot field
  with 1–20 validation, dynamic slot-grid sizing.

Explicitly NOT modified: `multi-target-deploy` (compose passing `MAX_CONCURRENT_TASKS`
stays valid as the bootstrap default) and `audit-history`.

## Impact

- **Backend (apps/api):**
  - `src/guardrails/semaphore.ts` — `_maxConcurrentTasks` loses `readonly`; new setter with
    raise-promotion loop.
  - `src/guardrails/guardrails.service.ts` / `guardrails.module.ts` — bootstrap DB override
    after env seed; expose setter pass-through.
  - `src/tasks/tasks.service.ts` — extend `onApplicationBootstrap` reclaim into two-phase
    recovery (re-offer queued, ordered `createdAt asc`).
  - `src/settings/*` — persist/read the system-level value; call the guardrails setter on
    save (SettingsModule imports GuardrailsModule; precedent: MetricsModule).
  - `prisma/schema.prisma` + hand-written SQL migration (no local DB; mirror the
    `20260609010000` migration style) for the single-row system settings storage.
- **Contracts (packages/contracts):** `src/settings.ts` — new 1–20 int field following the
  `RetentionDaysSchema` constraint precedent.
- **Web (apps/web):** `components/settings/settings-form.tsx`, `lib/api/mutations.ts`
  (metrics invalidation), `lib/api/mock.ts` (CEILING/mockSettings/DEFAULT_STATE),
  `components/dashboard/capacity-aside.tsx` (dynamic grid columns).
- **Docs:** `.env.example:37` — reword `MAX_CONCURRENT_TASKS` as first-boot default.
- **Tests:** colocated plain-node `.mjs` tests (setter promotion loop, shrink no-eviction
  convergence, startup queued re-offer with param restore, settings 1–20 validation).
- **Dependencies/systems:** none new — same process, direct injection, no event emitter,
  no Redis/queue infra.
