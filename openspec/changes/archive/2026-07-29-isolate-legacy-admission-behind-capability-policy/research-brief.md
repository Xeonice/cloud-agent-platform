# Research brief

All figures below were measured on the working tree at `622dac6`, not estimated.
Commands are recorded so any number here can be re-derived.

## 1. What the admission mode decision actually is today

`apps/api/src/tasks/tasks.service.ts:1113`

```ts
const admissionMode = (this.taskAdmissionGate?.isEnabled() ?? false)
  ? 'durable-v2'
  : 'legacy';
```

One anonymous ternary, evaluated once per acceptance and frozen. It has exactly
one reachable answer when the gate is anything other than fully open: `legacy`.

Two distinct situations collapse into that same answer:

- the gate is **present and closed** — one of ten enumerated reasons applies
- the gate is **absent** (`this.taskAdmissionGate` is `undefined`) — a DI
  regression, which `?? false` silently converts into `legacy` with no reason at
  all. This case is not in the closed-reason enum and cannot be distinguished
  downstream from a legitimately closed gate.

## 2. What "the deployment cannot prove admission-v2 capability" means

`packages/contracts/src/task-admission-capability.ts` —
`evaluateTaskAdmissionV2Gate()` checks, in order:

| # | Check | Closed reason |
|---|---|---|
| 1 | `CAP_TASK_ADMISSION_V2_ENABLED` is `1`/`true` | `disabled` |
| 2 | attestation present and parses | `deployment_attestation_missing` / `_invalid` |
| 3 | `expiresAt > now` | `deployment_attestation_expired` |
| 4 | no report from an undeclared instance×role | `worker_report_unexpected` |
| 5 | every declared instance×role has a report | `worker_report_missing` |
| 6 | every report lists `task-admission-v2` | `worker_capability_missing` |
| 7 | every report is `ready` and not future-dated | `worker_not_ready` |
| 8 | both `api` and `worker` roles are covered | `worker_report_missing` |
| 9 | all reports share ONE `buildIdentity` | `mixed_build_identity` |
| 10 | the local process verifies itself against the document | (`verifyLocalProcess`) |

The attestation is an operator-signed roster (`expectedWorkers`) plus each
process's self-report. Membership is never inferred from reports — the schema
comment states this deliberately, so a half-started deployment cannot convince
itself it is complete.

The mechanism protects durable admission's database rows from being consumed by a
process on a different build (check 9).

### Deployment-side refusals

`scripts/quick-deploy.sh` refuses to enable the gate at all when:

- `SELECTED_PROVIDER=control-plane` (line 671) — no runnable sandbox
- `BOXLITE_PROTOCOL_MODE != native` (line 674) — *"cap-rest cannot prove
  disk_size_gb/rootfs enforcement"*; corroborated by
  `packages/sandbox-provider-boxlite/src/boxlite-config.ts:591`
- `CAP_BOXLITE_SKIP_RUNTIME_PROBE=1`

The disk constraint is not cosmetic: admission-v2 admits against a capacity
计算 (`validate_boxlite_host_capacity`: available ≥ per-task disk × concurrency).
Under cap-rest the per-task limit is unenforceable, so the arithmetic is unfounded.

Also structural (line 670): the first deployment of any rollout **must** run with
the gate false, because the roster is generated from that deployment's own
self-reports. Stage one is therefore always a legacy-mode deployment.

## 3. control-plane does not need the legacy path

Measured, not assumed. `apps/api/src/guardrails/guardrails.service.ts:2636`:

```ts
const sandbox = this.sandbox;
if (sandbox) { /* 347-line provisioning block */ }
else {
  const error = new Error('Sandbox provider unavailable');
  ... forceFail(taskId, 'provision_failed') ...
}
```

In `control-plane` mode no provider is bound, so the task fails immediately. The
legacy path there only produces a clean failure, which the durable path can
produce equally. This removes one of the four apparent blockers to retiring
legacy.

## 4. The legacy pipeline is already physically separable

Not the entangled core it appears to be. Measured by mention density and by
method-name ownership over the class body (lines 370–4275):

| | legacy mentions | durable mentions |
|---|---|---|
| `startRunningAfterCapacity` (388 lines) | 34 | 2 |
| `processDurableAdmissionAfterCapacity` (273 lines) | 1 | 10 |

Method-name ownership: 12 methods / 364 lines carry `Legacy`; 13 methods / 890
lines carry `Durable`. The earlier reading that "12 methods / 1546 lines entangle
both paths" was measuring *branch dispatch mentioning both modes*, not shared
method bodies.

### What extraction costs

Inside the 347-line block, `this.<method>(` calls resolve to 17 distinct methods:

- **8 are legacy-exclusive** and move with it: `settleLegacyProvisioningSupersession`
  (×13), `finishLegacyProvisioningFailure` (×4), `rememberLegacyProvisioningFailure`
  (×3), `beginLegacyProvisioning`, `releaseLegacyProvisioning`,
  `observeLegacyProvisioningDiagnostics`, `observeLegacyAgentLaunchDiagnostics`,
  `rememberLegacyProviderUnavailable`
- **9 are shared with the durable path** and become the callback surface:
  `waitForRunningAdmission` (×7), `clearAdmissionRuntime` (×9), `failProvisioning`
  (×2), `forceFail` (×2), `settleProvisioningDiagnostics` (×2),
  `resolveProvisionPlan`, `resolveWorkspaceSource`, `buildWorkspaceProgressChain`,
  `resolveSelectedRun`

Instance state touched: shared — `terminalTasks`, `terminalTaskStatuses`,
`connections`, `gateway`, `logger`; legacy-exclusive —
`legacyProviderBoundariesCrossed`, `legacyDiagnosticPositions`.

## 5. Safety net

```
node --test dist/guardrails/*.spec.js
  122 tests / 122 pass / 0 fail / 2.48s
```

With `--experimental-test-coverage` over `guardrails.service.js`:

- line coverage 2100 / 2504 = **83.9%**
- branch coverage 619 / 760 = **81.4%**
- `startRunningAfterCapacity` executed **50** times
- `processDurableAdmissionAfterCapacity` executed **46** times
- `admit` 57, `onTerminal` 29, `settleTask` 25, `forceFail` 20, `readopt` 13

29 of 161 functions never execute; all are periphery — leaf accessors
(`runnerMinuteIntervals`, `semaphoreProjection`, `sandboxMode`,
`sandboxCapabilities`, `setMaxConcurrentTasks`, `recordActivity`), timer callbacks
(`onIdleExceeded`, `onDeadlineExceeded`, `onTrip`, `flush`), bootstrap hooks, and
11 anonymous closures. The pipeline itself has no blind spot.

## 6. Observability that already exists (do not re-invent)

`GET /deployment-capabilities/task-admission-v2` already returns
`{ capability, gate: evaluate(), localReports }` — so the closed reason **is**
retrievable at deployment level. Per-task, `task-provisioning-diagnostics`
already records `admissionMode` on every attempt.

What is missing is not a viewing surface. It is that the *decision* carries no
reason with it: `tasks.service.ts` reduces a ten-valued gate result to a boolean
before choosing, so nothing downstream of the ternary can state why this task took
the path it took without independently re-querying the gate.

## 7. Conflict surface

No active change touches `guardrails`:

| stale change | files mentioning guardrails | mentioning contracts |
|---|---|---|
| expand-recurring-task-time-controls | 0 | 4 |
| harden-scheduled-task-dispatch-and-local-e2e | 0 | 2 |
| redesign-settings-single-column | 0 | 2 |
| runtime-same-host-release-web | 0 | 0 |
| session-approval-flow | 0 | 1 |
| simplify-sandbox-image-model | 0 | 4 |
| static-terminal-log | 0 | 1 |
| use-local-account-quick-deploy | 0 | 0 |

## 8. Precedent in this repository

`fail-loud-on-unknown-runtime` (archived, `a6441c1`) deleted an allow-list that
silently accepted unknown runtimes and replaced it with a thrown
`UnknownRuntimeError`. The legacy fallback is the same shape one layer up: a
capability that cannot be proven currently results in silently proceeding down a
different path. That change is the model for making the consequence explicit —
but note it *changed* the consequence, whereas this change deliberately does not
(see the proposal's Non-Goals).

## 9. Layout constraint

`scripts/api-module-layout-check.mjs` currently ships with `ALLOWED_CYCLES = []`.
Any new directory extracted from `guardrails` must not import `guardrails` while
`guardrails` imports it, outside `*.module.ts` composition. `guardrails` already
has out-edges to 16 directories.
