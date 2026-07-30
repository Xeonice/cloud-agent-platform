## Context

Measurements backing every figure here are in `research-brief.md`.

Today one line decides which of two admission pipelines a task takes:

```ts
// apps/api/src/tasks/tasks.service.ts:1113
const admissionMode = (this.taskAdmissionGate?.isEnabled() ?? false)
  ? 'durable-v2'
  : 'legacy';
```

`isEnabled()` is a boolean projection of `evaluateTaskAdmissionV2Gate()`, which
distinguishes ten closed reasons. The `?.` and `?? false` add an eleventh
situation — no gate provider at all — that the reason enum does not model. All
eleven collapse to the string `'legacy'`, and everything downstream consumes only
that string.

The pipeline that string selects is not a separate unit. Inside
`GuardrailsService` (3,906 lines, 90 methods), `startRunningAfterCapacity` is 388
lines of which a single `if (sandbox)` block spans 347. That block mentions
`legacy` 34 times and `durable` twice; its durable counterpart,
`processDurableAdmissionAfterCapacity`, is the mirror image (1 / 10). So the two
pipelines are already distinct in fact, and undistinguished in structure.

Constraints:

- `scripts/api-module-layout-check.mjs` ships with `ALLOWED_CYCLES = []`. Any new
  directory must not form a non-composition cycle with `guardrails`.
- 122 guardrails tests (83.9% line, 81.4% branch over the service; the target
  block executed 50 times) are the behavioural contract and must not be rewritten
  to fit the new shape — a test edited to accommodate a refactor stops being
  evidence that the refactor preserved behaviour.
- `GET /deployment-capabilities/task-admission-v2` already publishes the gate
  result. This change must not duplicate that surface.

## Goals / Non-Goals

**Goals:**

- Make the admission-mode decision a named, total, reason-carrying policy.
- Distinguish "gate absent" from "gate closed".
- Give the legacy pipeline a physical boundary and an enumerable coupling surface.
- Preserve observable behaviour exactly, proven by the unmodified test suite.

**Non-Goals:**

- Changing what the policy decides. Unproven capability still degrades to legacy.
- Enabling a refusal outcome. It becomes expressible; it is not registered.
- Touching the attestation format, the two-stage rollout, cap-rest capability, or
  attestation renewal.
- Splitting the durable pipeline, or reducing `GuardrailsService` beyond what the
  legacy extraction removes.
- Deleting the legacy pipeline.

## Decisions

### D1 — The policy is a total `Record` over gate outcomes, not a predicate

A `Record<AdmissionCapabilityOutcome, AdmissionModeDecision>` where the key union
is the gate's closed-reason enum plus `open` plus `gate-absent`. Adding a reason
to the enum without adding a key stops compiling.

*Alternative rejected — keep `isEnabled(): boolean` and add a separate reason
lookup.* Two reads of the same state can disagree, and the boolean would remain
the thing call sites consume, so the reason would be decorative. The reason has to
be part of the decision, not alongside it.

*Alternative rejected — a `switch` with `default`.* A `default` arm is exactly the
silent inheritance this change exists to remove. This mirrors the total-mapping
choice already made in `SANDBOX_PROVIDER_CAPABILITY_CLASSES`
(`enforce-provider-contract-parity`) and the registration-derived type guard in
`fail-loud-on-unknown-runtime`.

### D2 — "Gate absent" is a named outcome, not a coerced `false`

`this.taskAdmissionGate?.isEnabled() ?? false` currently makes a wiring regression
indistinguishable from an expired attestation. The resolver takes the optional
provider and maps its absence to its own outcome key.

*Alternative rejected — make the provider required.* That is a real improvement
but changes DI construction for focused test contexts that deliberately omit it,
which would force construction edits across suites this change has no reason to
touch.

### D2a — `TaskAdmissionGatePort` returns the gate result, not a boolean

Discovered while implementing D1: the flattening does not start at the ternary. It
starts one layer earlier, in the port itself —

```ts
export interface TaskAdmissionGatePort { isEnabled(): boolean; }
```

The port destroys the reason before any call site can see it, so a policy built on
top of `isEnabled()` could only ever recover the reason by reading the gate a
second time. The port's single method therefore becomes
`evaluate(): TaskAdmissionV2GateResult`. Keeping `isEnabled()` would be keeping
the defect.

Four spec files construct this port as a stub (`v1-task-durable-latency`,
`task-acceptance`, `mcp`, `durable-admission-cross-surface`). Their stub *shape*
changes; no assertion does. The counting stub in `task-acceptance.spec.ts` that
proves read-once-and-freeze keeps its counter and its assertions and only renames
the method it counts. **The guardrails suite stubs a different port
(`TaskProvisioningDiagnosticsWriteGatePort`) and is not affected at all**, so the
behaviour-preservation evidence for the extraction is untouched.

*Alternative rejected — add an optional `evaluate?()` alongside `isEnabled()`.*
Zero test churn, but a gate that reports closed while unable to report a reason
would become a twelfth outcome that exists only because test doubles exist —
letting the shape of the test doubles leak into production semantics — and two
readers of one state can disagree.

*Alternative rejected — inject `TaskAdmissionCapabilityService` alongside the port
purely for attribution.* That is the two-reads-of-one-state design already
rejected in D1; the reason would be decorative rather than part of the decision.

### D3 — The extracted unit is named for the pipeline, not for "legacy"

`legacy` describes a lifecycle position, not a responsibility, and the directory
should still make sense on the day the pipeline is deleted (it will be deleted as
a unit) or on the day it turns out to be retained. The directory is named for what
the code does — synchronous, in-request admission — with the legacy relationship
stated in its header comment.

*Alternative rejected — `guardrails/legacy/`.* A subdirectory of `guardrails` is
invisible to the module-layout gate, which reasons about top-level directories.
The boundary would exist for readers and not for the tool, which is the situation
this whole programme has been correcting.

### D4 — Coupling runs one way through a port owned by the extracted unit

The 9 orchestrator methods the block reaches (`waitForRunningAdmission` ×7,
`clearAdmissionRuntime` ×9, `failProvisioning` ×2, `forceFail` ×2,
`settleProvisioningDiagnostics` ×2, `resolveProvisionPlan`,
`resolveWorkspaceSource`, `buildWorkspaceProgressChain`, `resolveSelectedRun`)
become an interface the extracted unit declares and `GuardrailsService`
implements. Guardrails depends on the new directory; the new directory depends on
its own port only. That keeps the dependency acyclic without a module-composition
exemption.

The 8 legacy-exclusive helpers and the two legacy-exclusive fields
(`legacyProviderBoundariesCrossed`, `legacyDiagnosticPositions`) move with the
block. The shared fields (`terminalTasks`, `terminalTaskStatuses`, `connections`,
`gateway`) stay in guardrails and are reached only through port methods.

*Alternative rejected — pass `GuardrailsService` itself into the extracted unit.*
The coupling surface would stay implicit and the whole point is to make it
countable.

### D4a — The boundary is the whole legacy cluster, not the block (supersedes D4's extent)

D4 sized the extraction from a coupling set that had only been scanned **inward**
— which `this.*` the block reaches. Scanning outward at the start of Track 3 (full
numbers in `baseline.md`) showed both fields D4 called legacy-exclusive have
readers on the *shared* terminal path, three further legacy state containers were
never listed, 5 of the 12 legacy methods have callers outside the block, and two
helpers the durable path also runs carry `admissionMode === 'legacy'` branches
inside them.

So the legacy pipeline is not the 347-line block. It is a diagnostic-bookkeeping
state cluster spanning admission **and** terminal settlement, and terminal
settlement is shared. Three cuts were measured (`port OUT` = unit → orchestrator,
`entry IN` = orchestrator → unit):

| cut | lines | port OUT | entry IN | total | deletable as a unit |
|---|---|---|---|---|---|
| whole cluster (12 methods + block) | 696 | 21 → ~15 | 9 → ~9 | **~24** | yes |
| methods only, block stays | 336 | 11 → ~7 | 16 | ~23 | no |
| block only (D4's extent) | 360 | 22 → ~20 | 6 | ~26 | no |

No cut has a small interface; the coupling is roughly uniform at 23–26 crossings
wherever it is made. D4's "re-cut if it exceeds ~12" assumed a better cut existed.
It does not — so the criterion changes from *smallest interface* to **smallest
remaining cleanup cost on the day the pipeline is deleted**, which is the purpose
this change serves.

By that criterion the whole cluster wins outright: retirement becomes
`rm -rf` one directory plus the ~9 entry points the compiler then reports, instead
of locating ~756 lines spread across five places by reading. The block-only cut is
rejected precisely because deleting its directory would leave every legacy state
container orphaned inside `guardrails` — the opposite of D3's intent.

The price is paid now and knowingly: the extraction edits `settleTask`,
`fenceTerminal`, and `tryBeginProvisioningDiagnostics`, which the durable pipeline
also executes. D5's zero-test-edit rule is what makes that price safe to pay — the
122 tests cover terminal settlement, cancellation, provisioning failure, and slot
release, and any of those changing is a failed extraction, not a test to update.

*Alternative rejected — consolidate the six state containers into one named object
and move nothing else.* Costs nothing and makes the state greppable by one symbol,
but leaves all 696 lines of legacy code in place, so retirement day still begins
with reading `startRunningAfterCapacity` to find where the pipeline is. It
optimises the cost of this change rather than the cost of the deletion.

*Alternative rejected — drop the extraction and keep only the policy.* Defensible
while the deployment prerequisites are unscheduled, but it leaves the boundary
question to be answered twice: once by this measurement, and again by whoever
deletes it.

As built the port is 18 members and the entry surface 10, against D4's predicted
9. Since the criterion is no longer interface size, those counts are reported
rather than treated as a failure. Two of the 18 were not in the measurement and
were found by the suite rather than by analysis: the pipeline must log through the
orchestrator's own logger field, read per call, because the log context is
asserted and the test replaces that field after construction.

### D5 — Behaviour preservation is proven by leaving the guardrails tests alone

The 122 existing guardrails tests run unmodified. Where a test constructs
`GuardrailsService` directly, the extracted unit must be wired by the same
construction path, not injected by the test. If one of those tests must change to
keep passing, that is evidence the extraction changed behaviour, and the
extraction is wrong — not the test.

The rule is scoped to that suite deliberately, and to *assertions* elsewhere.
Track 2 adds new tests by design, and D2a renames a stubbed method in four spec
files outside the guardrails suite. Neither is re-baselining: the check that
matters is that no existing assertion was weakened or rewritten to accommodate
this change.

Coverage of the extracted block is checked before and after
(`node --test --experimental-test-coverage`) so a silent drop in exercised lines
is visible.

### D6 — Attribution reuses existing surfaces

The resolved decision carries its reason and is logged at the acceptance point.
No new persisted column, no change to the capability endpoint response, no change
to the strict provisioning-diagnostic schemas — those are `.strict()` and any
added field would be a mixed-version hazard of exactly the kind the attestation
exists to prevent.

## Risks / Trade-offs

- **[The 347-line block hides state coupling the call analysis missed]** → Extract
  in two commits: first move the legacy-exclusive helpers and fields with the
  block into the new directory but keep the call into it from
  `startRunningAfterCapacity`; only then invert to the port. Each step runs the
  full suite, so a missed dependency surfaces as a compile error or a red test,
  not as a behavioural drift discovered later.

- **[The port grows past 9 methods once the compiler sees everything]** → Treat
  the count as a measured signal, not a target. If it exceeds ~12 the extraction
  boundary is wrong and should be re-cut before continuing rather than papered
  over with a wider interface.

- **[The policy becomes a place where the consequence quietly changes]** → The
  spec pins the mapping's result: unproven capability resolves to legacy. A future
  change to a refusal outcome is a spec change, visible as such.

- **[The extraction makes the eventual deletion harder rather than easier]** →
  Mitigated by D3: the unit is deletable as a directory. If the retirement
  decision lands the other way and legacy is retained, the same boundary is what a
  split would have needed anyway.

- **[Reduced churn tolerance: 6 stale changes touch `contracts`]** → None touch
  `guardrails`, so this change is conflict-free today. It should not be left
  parked; the longer it sits, the more likely `guardrails` acquires an unrelated
  edit.

## Migration Plan

No runtime migration. No environment variable, database, or wire-format change.
Deployments observe identical behaviour before and after; the capability endpoint
returns the same shape.

Rollback is a revert of the change — there is no persisted state to unwind.

## Open Questions

None blocking. The three deferred deployment-side questions (cap-rest capability,
two-stage rollout, attestation renewal) are recorded as Non-Goals in the proposal
and each needs its own evidence before it can be scheduled.
