# Pre-change baseline

Captured on the working tree at `622dac6`, before any task in this change was
applied. Task 4.2 compares against these numbers; task 4.3 compares against the
"no test file modified" rule.

## Suite (task 1.1)

```
pnpm exec turbo run build --filter=@cap/api
node --test --test-force-exit "dist/guardrails/*.spec.js"

  122 tests / 122 pass / 0 fail / 0 skipped / 2527 ms
```

## Coverage (task 1.2)

`node --test --experimental-test-coverage --test-reporter=lcov` over the same
suite. Two aggregates are recorded because the extraction moves production lines
between files — the production-only figure is the one that must not drop.

**Production sources under `dist/guardrails/` (6 files, excludes `*.spec.js`)**

| | covered / total | % |
|---|---|---|
| lines | 2323 / 2800 | **83.0** |
| branches | 682 / 835 | **81.7** |

**`guardrails.service.js` alone**

| | covered / total | % |
|---|---|---|
| lines | 2100 / 2504 | 83.9 |
| branches | 619 / 760 | 81.4 |

**Per production file**

| file | lines | branches |
|---|---|---|
| guardrails.service.js | 2100 / 2504 | 619 / 760 |
| semaphore.js | 77 / 92 | 25 / 29 |
| idle-tracker.js | 44 / 75 | 11 / 13 |
| deadline-watcher.js | 40 / 49 | 11 / 11 |
| circuit-breaker.js | 33 / 51 | 5 / 11 |
| transfer-progress-throttle.js | 29 / 29 | 11 / 11 |

**Key method execution counts** (these must not fall after extraction)

| method | executions |
|---|---|
| admit | 57 |
| startRunning | 53 |
| startRunningAfterCapacity | **50** |
| processDurableAdmissionAfterCapacity | 46 |
| onTerminal | 29 |
| settleTask | 25 |
| forceFail | 20 |
| readopt | 13 |
| recordExit | 5 |

## Coupling set, re-derived from source (task 1.3)

Boundaries computed by brace balance, not by line offset:

```
startRunningAfterCapacity   2609 .. 2996   = 388 lines
  if (sandbox) { … }        2637 .. 2983   = 347 lines
```

The 28 lines before the `if` are orchestrator bookkeeping — idle-ceiling arming,
`runnerMinutes.recordStart`, deadline arming. **They stay in guardrails**; only the
`if (sandbox)` block and its `else` branch move. The brief did not distinguish
this; it matters because those lines touch `this.idle`, `this.deadlines`,
`this.runnerMinutes`, and `this.defaultIdleTimeoutMs`, none of which would
otherwise need to appear on the port.

### Legacy-exclusive methods — move with the block (8)

| method | call sites |
|---|---|
| settleLegacyProvisioningSupersession | 14 |
| finishLegacyProvisioningFailure | 5 |
| rememberLegacyProvisioningFailure | 3 |
| rememberLegacyProviderUnavailable | 2 |
| beginLegacyProvisioning | 1 |
| observeLegacyProvisioningDiagnostics | 1 |
| releaseLegacyProvisioning | 1 |
| observeLegacyAgentLaunchDiagnostics | 1 |

### Shared with the durable path — the port surface (9)

| method | call sites |
|---|---|
| clearAdmissionRuntime | 9 |
| waitForRunningAdmission | 7 |
| forceFail | 3 |
| failProvisioning | 2 |
| settleProvisioningDiagnostics | 2 |
| resolveProvisionPlan | 1 |
| resolveWorkspaceSource | 1 |
| buildWorkspaceProgressChain | 1 |
| resolveSelectedRun | 1 |

This is exactly the set the design predicted (9). Per design D4, if the compiler
demands materially more than this, the boundary is re-cut rather than the
interface widened.

### Instance fields the moving code touches

| field | shared or legacy-exclusive |
|---|---|
| logger (×7) | shared |
| terminalTaskStatuses (×3) | shared |
| terminalTasks (×3) | shared |
| connections (×1) | shared |
| gateway (×1) | shared |
| sandbox (×1) | shared — but passed in as the `if` subject |
| legacyProviderBoundariesCrossed (×1) | **legacy-exclusive**, moves |
| legacyDiagnosticPositions (×1) | **legacy-exclusive**, moves |

Fields left in the preamble and therefore not moving: `idle`, `deadlines`,
`runnerMinutes`, `defaultIdleTimeoutMs`.

## Correction to task 1.3, found at the start of Track 3

The coupling set above was derived by scanning **inward** — which `this.*` the
moving block reaches. It never asked the opposite question: who *else* reaches the
things the block reaches. Both answers are needed to know what can move, and the
second one changes the conclusion.

Scanning outward over the whole legacy cluster (12 `*Legacy*` methods plus the
`if (sandbox)` block, ranges computed by brace balance):

| member | total refs | refs from **outside** the cluster |
|---|---|---|
| legacyCleanupNotRequired | 3 | **3** — 2313, 2380 (`settleTask`), 3224 (`settleProvisioningDiagnostics`) |
| legacyDiagnosticPositions | 6 | **2** — 2377 (`settleTask`), 3103 (`tryBeginProvisioningDiagnostics`) |
| legacyDiagnosticAttempts | 4 | **2** — 2376 (`settleTask`), 3102 (`tryBeginProvisioningDiagnostics`) |
| legacyProviderBoundariesCrossed | 3 | **2** — 2286, 2379 (`settleTask`) |
| legacyProvisioningFailureCandidates | 4 | **1** — 2378 (`settleTask`) |
| settleLegacyProvisioningSupersession | 18 | **2** — 2585 (`startRunning`), 3120 (`tryBeginProvisioningDiagnostics`) |
| abortLegacyProvisioning | 2 | **1** — 2031 (`fenceTerminal`) |
| resolveLegacyTerminalDiagnosticAttempt | 1 | **1** — 2281 (`settleTask`) |
| settleLegacyTerminalPrimary | 2 | **1** — 2305 (`settleTask`) |

So:

- **Both fields task 1.3 called "legacy-exclusive, moves" have external readers.**
  `legacyProviderBoundariesCrossed` is *read* at 2286 on the shared terminal path;
  `legacyDiagnosticPositions` is written at 3103 by a helper the durable path also
  calls. Neither is exclusive to the block. The same is true of the three legacy
  containers task 1.3 did not list at all.
- **5 of the 12 legacy methods have callers outside the block**, including
  `settleLegacyProvisioningSupersession`, the single most-called one (18 sites).
- **Two shared helpers carry `admissionMode === 'legacy'` branches inside them** —
  `tryBeginProvisioningDiagnostics` (3095, 3119) and `settleProvisioningDiagnostics`
  (3224). The legacy pipeline is not only a block; it is a mode-conditional inside
  code the durable pipeline runs.

The legacy pipeline's *state* therefore spans admission **and** terminal
settlement, and terminal settlement is shared. Extracting only the block leaves
every legacy container behind in `guardrails`, which means the port must expose
them as accessors and the extracted directory stops being deletable as a unit —
the property design D3 exists to create.

### Re-measured boundary for the whole cluster

```
cluster = 12 legacy methods + the if(sandbox) block   = 696 lines
```

What the cluster reaches into `GuardrailsService`, split by how it would be
satisfied:

**Constructor-injected (the new unit takes these from DI, not from the port):**
`prisma` ×2, `provisioningDiagnosticRecorder` ×1,
`provisioningDiagnosticWriteGate` ×2, `sandbox` ×2, `gateway` ×1,
`connections` ×1, plus its own `logger` ×7.

**True port back into the orchestrator (14 before collapsing):**

| member | refs | | member | refs |
|---|---|---|---|---|
| clearAdmissionRuntime | 10 | | failProvisioning | 2 |
| waitForRunningAdmission | 9 | | buildWorkspaceProgressChain | 1 |
| settleProvisioningDiagnostics | 8 | | resolveProvisionPlan | 1 |
| terminalTaskStatuses | 5 | | resolveSelectedRun | 1 |
| forceFail | 3 | | resolveWorkspaceSource | 1 |
| terminalTasks | 3 | | settleCleanupDiagnostics | 1 |
| terminalTaskStatus | 1 | | tryResumeProvisioningDiagnostics | 1 |

`terminalTasks` / `terminalTaskStatuses` / `terminalTaskStatus` collapse to two
accessors, giving **~12**. Design D4's re-cut trigger is "materially more than 9",
and the risk register's is "exceeds ~12". This sits exactly on that line, which is
why Track 3 stopped here rather than widening the interface silently.
