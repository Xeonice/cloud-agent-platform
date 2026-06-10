# Verification Report: configurable-task-slots

Date: 2026-06-10
Pass: adversarial verify (opsx-verify), three-way routing adjudication

## Verdict Summary

| Destination | Count |
|---|---|
| UNMET → reopened code tasks | 0 |
| SPEC-DEFECT → design.md Open Questions | 0 |
| MET (incl. reclassified from raw-unmet) | 7 / 7 requirements |

The skeptic pass produced an **empty raw-unmet list** — no requirement was
refuted. Every requirement in the four spec deltas re-traces end-to-end to
implementing code. No tasks were re-opened and no spec defects were routed to
design.md (its "Open Questions" section remains "None").

## Requirement Verdicts (all MET)

### account-settings

- **System-level task slot ceiling setting — MET.**
  `SettingsService.readSystemCeiling()` resolves `dbSetting ?? env
  MAX_CONCURRENT_TASKS ?? 5`; persistence is a fixed-id upsert on
  `SystemSettings` (`SYSTEM_SETTINGS_ROW_ID`); a successful save synchronously
  pushes `guardrails.setMaxConcurrentTasks(n)` so the ceiling takes effect
  without restart. Invalid PATCH bodies 400 and mutate neither store nor live
  semaphore. Evidence: `apps/api/src/settings/settings.service.ts`,
  `apps/api/src/settings/settings-logic.ts`.

### guardrails

- **Concurrency semaphore bounds running tasks (runtime-mutable ceiling) — MET.**
  `ConcurrencySemaphore.setMaxConcurrentTasks()` rejects non-positive /
  non-integer values without mutation; a raise loops `admitNext()` promoting
  the oldest queued tasks FIFO; a lower evicts nothing and converges as tasks
  release. Evidence: `apps/api/src/guardrails/semaphore.ts`,
  `apps/api/src/guardrails/semaphore.test.mjs`.
- **Startup recovery reclaims orphaned tasks and re-offers queued tasks — MET.**
  `TasksService` two-phase bootstrap: Phase 1 reclaim
  (`running`/`awaiting_input` → `failed`) via `reclaimOrphanedOnStartup()`,
  then the persisted ceiling is loaded (`loadPersistedCeiling()`, optional-
  chained on the narrow `IGuardrailsService`) **before** Phase 2
  `reofferQueuedOnStartup()` re-offers DB `queued` tasks in `createdAt asc`
  order with `deadlineMs`/`idleTimeoutMs` restored from each row. The specced
  ordering scenario (persisted 2, env 5, 3 queued ⇒ exactly 2 admitted) is
  covered by colocated `.mjs` tests. Evidence:
  `apps/api/src/tasks/tasks.service.ts`,
  `apps/api/src/guardrails/guardrails.service.ts`.

### resource-metrics

- **Derived capacity metrics are exact projections of semaphore state — MET.**
  `MetricsService.build()` → `projectCapacity()` reads the live semaphore
  ceiling per request; shrink-overage transitional window handled by
  `Math.max(0, ceiling - active)` clamping per the spec's transitional-overage
  clause. Evidence: `apps/api/src/metrics/metrics-projection.ts`.
- **Slot occupancy table enumerates the running set and the queue — MET.**
  `buildSlotOccupancy()` builds exactly `ceiling`-many slots from
  `snapshotRunning()` / `snapshotQueue()`, defensive against overage.
  Evidence: `apps/api/src/metrics/metrics-projection.ts`.

### frontend-console

- **Settings page with slot ceiling control — MET.**
  Numeric slot ceiling control in `settings-form.tsx` via the existing
  draft/validate/onSave pattern, client-validated integer 1–20 (invalid values
  never submitted), presented as system-wide, reset restores 5;
  `saveSettingsMutation` invalidates both `queryKeys.settings` and
  `queryKeys.metrics` on success. Evidence:
  `apps/web/src/components/settings/settings-form.tsx`,
  `apps/web/src/lib/api/mutations.ts`.
- **Dashboard lists tasks as a fleet (slot meter derives from occupancy) — MET,
  with one non-blocking nuance.**
  The capacity aside derives slot-meter segment count and grid layout from
  `occupancy.slots.length` (no hardcoded ten-column grid); mock `CEILING`
  aligned to backend default 5; task list polls on `refetchInterval: 5000`
  (`apps/web/src/lib/api/queries.ts:75`). Nuance: the spec's parenthetical
  "with `refetchIntervalInBackground: true` if continuous background polling
  is required" is a **conditional** clause; the implementation omits the flag.
  The mandatory SHALL (5-second `refetchInterval`) is satisfied and every
  scenario ("Task list polls for fresh status") passes with the foreground
  interval — met-as-written; the minor gap does not block the primary
  scenario. Evidence: `apps/web/src/components/dashboard/capacity-aside.tsx`,
  `apps/web/src/lib/api/queries.ts`.

## Gap Analysis (requirements with no traceable implementation)

Result: **none.** Every named requirement has direct code implementing its
core behavior. The single near-miss examined was the
`refetchIntervalInBackground: true` configuration (frontend-console, dashboard
requirement) — absent in code, but the spec clause is conditional ("if
continuous background polling is required") and `refetchInterval: 5000` alone
satisfies the mandatory polling behavior. Adjudicated MET, recorded above.

## Scope Findings (implemented behavior beyond spec — informational, no action)

These are defensive additions with no matching spec requirement. None
contradicts a spec rule; all are benign hardening. Recorded for traceability,
not re-opened as tasks:

1. `apps/api/src/settings/settings-logic.ts:138-142` —
   `resolveMaxConcurrentTasks` clamps an oversized env seed (e.g.
   `MAX_CONCURRENT_TASKS=50`) into the 1–20 contract range for the settings
   READ shape rather than falling back to 5 or passing it through. No spec
   requirement mentions clamping out-of-range env seeds.
2. `apps/api/src/guardrails/guardrails.service.ts:293-295` —
   `GuardrailsService.onApplicationBootstrap()` unconditionally calls
   `loadPersistedCeiling()` in addition to the tasks startup recovery calling
   it first. Spec only requires the load before Phase 2 re-offer (guardrails
   6.2); this second load is redundant but idempotent.
3. `apps/api/src/guardrails/guardrails.service.ts:330` —
   `loadPersistedCeiling()` uses `prisma.systemSettings.findFirst()` instead
   of `findUnique()` on the fixed id. Functionally equivalent on a single-row
   table but deviates from the fixed-id addressing contract used by the write
   path.
4. `apps/api/src/settings/settings.service.ts:147-156` — second
   `isValidMaxConcurrentTasks` guard inside `updateSettings()` for non-HTTP
   callers, after the controller pipe already enforces the range. Unspecified
   second validation layer.
5. `apps/web/src/lib/store.ts:112-119` — `normalizeSlotCeiling()` defensively
   coerces stale persisted localStorage values to a valid ceiling from
   `normalizeState()`. No spec coverage of frontend local-storage migration.
6. `apps/web/src/components/settings/settings-form.tsx:82-91` —
   `readSlotCeiling()` structurally casts `AccountSettings` to
   `{ maxConcurrentTasks?: unknown }` with a fallback to 5 when absent or
   out-of-range. The spec expects the field present and valid in the response;
   the defensive cast for an optional wire field is unspecified (though the
   contracts field IS optional on the wire, so this aligns with the migration
   plan's older-bundle tolerance).
7. `apps/api/src/tasks/tasks.service.ts:51` — `IGuardrailsService` declares
   `loadPersistedCeiling` optional (`?`) so builds where guardrails-bootstrap
   is not wired still satisfy the narrow interface. The spec does not
   anticipate a partially-wired build; the bootstrap caller optional-chains.

## Three-Way Routing Tally

- reopenedTasks: [] (no UNMET findings — no `## Track: verify-reopened`
  section added to tasks.md)
- specDefects: [] (design.md "Open Questions" unchanged: "None")
- reclassifiedMet: [] (the raw-unmet list was empty; there was nothing to
  reclassify — the 7/7 MET verdicts above are first-pass confirmations, not
  reclassifications)
