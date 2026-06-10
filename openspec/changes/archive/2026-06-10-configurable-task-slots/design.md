# Design: configurable-task-slots

## Context

The slot ceiling is read once from `process.env.MAX_CONCURRENT_TASKS` at module
construction (`guardrails.module.ts`) into a `readonly _maxConcurrentTasks` on
`ConcurrencySemaphore`, so tuning concurrency requires a redeploy. Separately,
`reclaimOrphanedOnStartup` (`tasks.service.ts`) only fails `running`/`awaiting_input`
tasks on restart; DB `queued` tasks are never re-offered to the in-memory semaphore and
stay queued forever — a confirmed defect.

Four operator decisions were pre-resolved in the proposal and are **not** relitigated
here: (1) shrink = no-kick, (2) one global pool, (3) DB overrides env, (4) restart
re-offers queued tasks. This document records *how* those land in the codebase.

Constraints: single API process; in-memory semaphore is the only admission authority;
no Redis/queue infra; no local DB for `prisma migrate dev` (migrations are hand-written
SQL, mirroring `20260609010000_add_task_guardrail_controls`).

## Goals / Non-Goals

**Goals:**

- Runtime-mutable ceiling: settings save takes effect immediately, no restart.
- Persisted system-level value that survives restarts and wins over env.
- Two-phase startup recovery so queued tasks are never stranded.
- Keep the admission hot path (`offer()`) free of DB reads.

**Non-Goals:**

- Per-user/per-account ceilings (conflicts with the single shared semaphore).
- Evicting or interrupting running tasks on shrink.
- Distributed coordination (multi-process semaphore, Redis) — out of scope.
- Changing `multi-target-deploy` or `audit-history`; `MAX_CONCURRENT_TASKS` in compose
  stays valid as the first-boot seed.

## Decisions

### 1. Mutable semaphore setter with raise-promotion loop

`_maxConcurrentTasks` loses `readonly`; add `setMaxConcurrentTasks(n)` that rejects
non-positive/non-integer values without mutation, assigns, and on a raise loops the
existing `admitNext()` until capacity fills or the queue empties. On a lower, no code
runs against the running set — `hasCapacity` (`running.size < max`) going false stops
back-filling and the count converges as tasks release.
*Alternative considered:* eviction on shrink — rejected; no peer (BullMQ, GitLab Runner,
Solid Queue, pg-boss) kills surplus running work, and the existing `admitNext()`
FIFO machinery already gives correct convergence for free.

### 2. Single-row SystemSettings storage, not AccountSettings

New single-row storage (fixed id + upsert) holding `maxConcurrentTasks`. Explicitly NOT
a column on `AccountSettings`: its `userId @unique` scoping and the "SHALL NOT leak
across accounts" spec rule are semantically wrong for one global pool. Effective value
resolves as `dbSetting ?? envDefault ?? 5`.
*Alternative considered:* storing per-account and taking max/min across rows — rejected
as ambiguous and contradicting decision (2) above.

### 3. Push propagation, no read-path cache or events

`SettingsModule` imports `GuardrailsModule` (acyclic; precedent: `MetricsModule`) and
the settings save handler calls `guardrails.setMaxConcurrentTasks(n)` synchronously
after persisting. The in-memory ceiling is authoritative and written at exactly two
points: bootstrap load and settings push. `offer()` never queries the DB.
*Alternative considered:* event emitter or DB poll on each admission — rejected; adds
indirection/latency for a single in-process consumer.

### 4. Two-phase startup recovery, ordered ceiling-first

Extend `onApplicationBootstrap`: **Phase 1** keeps the existing reclaim
(`running`/`awaiting_input` → `failed`). Then the persisted ceiling override is loaded
into the semaphore **before** **Phase 2** re-offers DB `queued` tasks in
`createdAt asc` order via `admit(id, {deadlineMs, idleTimeoutMs})`, restoring both
params from each Task row — zero new columns, since `task-guardrail-controls` already
persisted them. Ordering matters: loading the ceiling after re-offer would admit
against the env seed instead of the persisted value (specced scenario: persisted 2,
env 5, 3 queued ⇒ exactly 2 admitted).

### 5. Contract validation 1–20, default 5

New settings field `z.number().int().min(1).max(20)` in `packages/contracts`
(precedent: `RetentionDaysSchema`). Floor ≥ 1 is mandatory — 0 starves the queue; the
20 cap is calibrated against Drone/GitLab runner defaults and sandbox-host capacity.
Rides the established GET/PATCH surface with "invalid body mutates nothing" +
read-back-after-write semantics; out-of-range ⇒ 400 and the live semaphore is untouched.

### 6. Web console derives, never hardcodes, the ceiling

Settings form adds the numeric slot field via the existing draft/validate/onSave +
`saveSettingsMutation` pattern, additionally invalidating `queryKeys.metrics` on
success. Dashboard slot grid derives columns from `occupancy.slots.length` instead of
hardcoded `grid-cols-10`; mock `CEILING` aligns to the real default 5.

### 7. Metrics: spec-only change

The projection already reads the live semaphore ceiling per request and clamps
defensively — no code change. Spec deltas only: drop the stale "equivalently
`MAX_CONCURRENT_TASKS`" wording and add a transitional-overage clause for shrink
convergence (while `running > ceiling`, "active + free === ceiling" temporarily breaks).

## Risks / Trade-offs

- [Shrink-convergence window: metrics invariants temporarily violated while
  `running > ceiling`] → covered by the explicit transitional-overage spec clause;
  projection already clamps, so no consumer crashes.
- [Settings save persists but the synchronous push throws, desyncing DB vs live
  ceiling] → setter is validated by the same contract range before persist; on
  process restart bootstrap reloads from DB, restoring consistency. Push call sits
  after the upsert in one request path, so failure surfaces as a 5xx to the operator.
- [Hand-written SQL migration drift vs `schema.prisma` (no local DB to verify)] →
  mirror the `20260609010000` migration style exactly and keep the model trivially
  small (single row, one int column + timestamps).
- [Re-offer at boot of a large queued backlog admits min(K, M) tasks at once,
  provisioning M sandboxes simultaneously] → bounded by the ceiling itself (≤ 20);
  identical worst case to steady-state full occupancy.
- [Two operators racing a settings write] → last-write-wins on a single row with
  upsert; acceptable for a single-instance operator tool, and reads converge.

## Migration Plan

1. Add the SystemSettings model to `schema.prisma` + hand-written SQL migration
   (additive; no backfill — absence of the row means "env seed applies").
2. Deploy backend: first boot after deploy finds no row, seeds from
   `MAX_CONCURRENT_TASKS` (or 5); behavior is unchanged until an operator saves.
3. Contracts field is optional on the wire, so older web bundles keep working;
   deploy web after API.
4. Rollback: revert the app deploy — the extra table is inert; the old code never
   reads it and env-only behavior resumes. No destructive migration to unwind.

## Open Questions

None — the four operator decisions were resolved in the proposal, and the remaining
choices (storage shape, push path, recovery ordering, validation range) are fixed above.
