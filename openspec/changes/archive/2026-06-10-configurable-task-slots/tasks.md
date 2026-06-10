<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time.
     Partition verified against the codebase (file-disjoint across concurrent waves):
       wave 1: contracts-slot-field | db-system-settings | semaphore-runtime-ceiling
       wave 2: guardrails-bootstrap | web-console-slots
       wave 3: settings-system-level | startup-queued-reoffer
       integration (serial, last): integration-verify-docs
     Seam note: 6.2 consumes the ceiling-load method 4.2 exposes on GuardrailsService;
     6.x edits only apps/api/src/tasks/* (the narrow IGuardrailsService interface lives
     in tasks.service.ts), so tracks 4 and 6 do not write the same files. -->

## 1. Track: contracts-slot-field (depends: none)

- [x] 1.1 Add an optional `maxConcurrentTasks` field to the settings schema in `packages/contracts/src/settings.ts`, validated `z.number().int().min(1).max(20)` with default 5, following the `RetentionDaysSchema` constraint precedent
- [x] 1.2 Add a colocated plain-node `.mjs` test in `packages/contracts/src/` covering acceptance of integers 1–20 and rejection of 0, 21, negatives, and non-integers

## 2. Track: db-system-settings (depends: none)

- [x] 2.1 Add a single-row `SystemSettings` model (fixed id, `maxConcurrentTasks` int, timestamps) to `apps/api/prisma/schema.prisma`
- [x] 2.2 Write the hand-written additive SQL migration for the new table under `apps/api/prisma/migrations/`, mirroring the `20260609010000_add_task_guardrail_controls` style (no backfill — absent row means env seed applies)

## 3. Track: semaphore-runtime-ceiling (depends: none)

- [x] 3.1 In `apps/api/src/guardrails/semaphore.ts`, drop `readonly` from `_maxConcurrentTasks` and add `setMaxConcurrentTasks(n)`: reject non-positive/non-integer values without mutating ceiling, running set, or queue; on a raise, loop the existing `admitNext()` until capacity fills or the queue empties; on a lower, no eviction code — `hasCapacity` going false stops back-filling
- [x] 3.2 Extend `apps/api/src/guardrails/semaphore.test.mjs`: raising from N to N+k with k queued promotes the k oldest in FIFO order immediately; lowering below the running count evicts nothing and converges as tasks release; invalid setter values leave all state unchanged

## 4. Track: guardrails-bootstrap (depends: db-system-settings, semaphore-runtime-ceiling)

- [x] 4.1 Expose a `setMaxConcurrentTasks` pass-through on `GuardrailsService` in `apps/api/src/guardrails/guardrails.service.ts` (and wire any provider changes in `guardrails.module.ts`), keeping env `MAX_CONCURRENT_TASKS` as the construction-time seed
- [x] 4.2 On bootstrap, load the persisted `SystemSettings` ceiling (when a row exists) into the semaphore after the env seed, so the effective ceiling resolves as `dbSetting ?? envDefault ?? 5` and the persisted value wins across restarts
- [x] 4.3 Add/extend colocated `.mjs` coverage: persisted N with env M boots to effective ceiling N; no persisted row boots to env value (or 5 when unset)

## 5. Track: settings-system-level (depends: contracts-slot-field, guardrails-bootstrap)

- [x] 5.1 Persist and read the system-level `maxConcurrentTasks` in `apps/api/src/settings/` via fixed-id upsert on `SystemSettings` (NOT on the per-account `AccountSettings` row); GET resolves `dbSetting ?? env MAX_CONCURRENT_TASKS ?? 5` so first boot reads the env seed
- [x] 5.2 Validate PATCH against the shared contracts schema: out-of-range/non-integer values respond 400 and mutate neither the stored value nor the live semaphore; valid updates read back exactly on a subsequent GET
- [x] 5.3 Make `SettingsModule` import `GuardrailsModule` (acyclic; precedent: `MetricsModule`) and, after a successful upsert, synchronously push `guardrails.setMaxConcurrentTasks(n)` so the save takes effect without restart
- [x] 5.4 Extend the colocated settings `.mjs` tests: valid save persists, reads back, and updates the live ceiling immediately; invalid body mutates nothing; a write by one operator is observed by another operator's read (single shared value)

## 6. Track: startup-queued-reoffer (depends: guardrails-bootstrap)

- [x] 6.1 Extend `onApplicationBootstrap` in `apps/api/src/tasks/tasks.service.ts` into two-phase recovery: keep the Phase 1 reclaim (`running`/`awaiting_input` → `failed`), then add Phase 2 re-offering DB `queued` tasks in `createdAt asc` order via `admit(id, {deadlineMs, idleTimeoutMs})` with both params restored from each Task row (zero new columns)
- [x] 6.2 Order recovery ceiling-first: the persisted ceiling override is loaded into the semaphore before Phase 2 runs (persisted 2, env 5, 3 queued ⇒ exactly 2 admitted)
- [x] 6.3 Add colocated `.mjs` tests: restart with K queued and ceiling M admits the oldest min(K, M) and leaves the rest queued in order (no stranding); re-offered tasks arm deadline/idle watchers with their persisted values

## 7. Track: web-console-slots (depends: contracts-slot-field)

- [x] 7.1 Add the slot ceiling numeric control to `apps/web/src/components/settings/settings-form.tsx` via the existing draft/validate/onSave pattern, client-validated as an integer in 1–20 (invalid values never submitted), presented as a system-wide shared value, with reset restoring the default 5
- [x] 7.2 In `apps/web/src/lib/api/mutations.ts`, make `saveSettingsMutation` additionally invalidate `queryKeys.metrics` on success so capacity surfaces refresh before the next 5-second poll
- [x] 7.3 Align `apps/web/src/lib/api/mock.ts` (`CEILING`, `mockSettings`, `DEFAULT_STATE`) to the real backend default of 5
- [x] 7.4 Derive the dashboard slot-meter segment count and grid layout in `apps/web/src/components/dashboard/capacity-aside.tsx` from `occupancy.slots.length` instead of the hardcoded ten-column grid, rendering one segment per slot for any ceiling in 1–20

## 8. Track: integration-verify-docs (depends: contracts-slot-field, db-system-settings, semaphore-runtime-ceiling, guardrails-bootstrap, settings-system-level, startup-queued-reoffer, web-console-slots)

<!-- INTEGRATION TRACK: runs serially after all parallel tracks merge.
     8.2/8.3 are cross-cutting gates over every track's output; 8.1 (.env.example)
     rides here as a doc-only single-file tweak. -->

- [x] 8.1 Reword `MAX_CONCURRENT_TASKS` in `.env.example` (line 37) as the first-boot seed only, noting the persisted settings value overrides it once saved
- [x] 8.2 Static gates GREEN: contracts build + tests; api `tsc` 0 / eslint 0; web `tsc` 0 / eslint 0 / vitest; full guardrails `.mjs` suites (semaphore incl. setter cases, exit-roundtrip, idle, breaker) + settings `.mjs` suites pass
- [x] 8.3 No `debugger`/stray artifacts in changed `apps/api/src`, `apps/web/src`, `packages/contracts/src` (grep clean)
