# runner-minutes-accounting Specification

## Purpose
TBD - created by archiving change extract-runner-minutes-ledger. Update Purpose after archive.
## Requirements
### Requirement: Running-interval state has exactly one owner, and it lives in platform-ops

The in-process running-interval ledger SHALL be owned by exactly one provider declared under
`apps/api/src/runner-metrics/` — the directory where `RunnerMinutesLedger` already lives.
`GuardrailsService` SHALL NOT import or construct the concrete `RunnerMinutesLedger` class: it
reaches the ledger only through the port type. Because `apps/api/src/guardrails/guardrails.service.spec.ts`
is frozen at zero diff by the guardrails capability and builds the service **positionally, with no
injector**, the orchestrator's `runnerMinutes` member SHALL be a private getter over two backing
members — one holding the owner resolved inside the already-existing `onModuleInit` `ModuleRef`
resolution, and one holding an injector-less fallback produced by the detached factory the port
file exports — returning the resolved owner when it exists and the fallback otherwise. Neither
backing member's name SHALL match the dependency-budget ratchet's symbol for this collaborator,
so the resolution plumbing cannot silently restore the symbol reference the change removes.
Exactly one ledger instance SHALL serve the writer (guardrails) and the reader (metrics) within a
booted process, so an interval opened on the write path is visible on the read path without any
second ledger; the detached instance SHALL serve no read and no write once the application is
booted.

#### Scenario: Guardrails no longer constructs a ledger

- **WHEN** the integrated tree is searched for `new RunnerMinutesLedger(`
- **THEN** every match is inside `apps/api/src/runner-metrics/`, and zero matches are inside
  `apps/api/src/guardrails/`

#### Scenario: Writer and reader observe the same ledger

- **WHEN** a task's run start is recorded through the guardrails write path in a booted
  application context and the metrics response is then built
- **THEN** the response's `runnerMinutes` block reports `available: true` and counts that
  task's interval, proving one instance serves both sides rather than two divergent ledgers

#### Scenario: The detached fallback is bypassed before anything is recorded

- **WHEN** the application is booted and a task's run start is then recorded through the guardrails
  write path
- **THEN** reading the orchestrator's `runnerMinutes` member yields an object identical to the
  provider registered under the DI token, and the fallback instance the field initializer produced
  has recorded zero intervals — the resolution happens in `onModuleInit`, which Nest runs before
  `onApplicationBootstrap` readoption and before any request-path write

#### Scenario: The fallback is a real ledger, not a silent no-op

- **WHEN** the detached instance produced by the factory is driven directly: one `recordStart` for
  a task, then `intervals()`, then `recordEnd` for the same task, then `intervals()` again
- **THEN** the first read returns exactly one interval with a null `endedAt` and the second returns
  that interval closed — so an injector-less instance genuinely accounts, and the reflective
  assertions in the frozen guardrails unit spec, all of which assert the ABSENCE of open intervals,
  cannot be satisfied vacuously by a fallback that records nothing

#### Scenario: The owner holds the state as a provider, not as module-level mutable state

- **WHEN** the owner file under `apps/api/src/runner-metrics/` is inspected
- **THEN** the ledger instance is a private field of a class registered as a DI provider under
  the port's token, and the file exports zero module-level mutable ledger instances

### Requirement: Cross-context access to the ledger is only through a port file and DI token

The owner SHALL be reachable from other bounded contexts only through a `*.port.ts` interface
under `apps/api/src/runner-metrics/` and the DI token that file exports. The port SHALL declare
exactly three methods — `recordStart(taskId)`, `recordEnd(taskId)`, `intervals()`. The port file
SHALL export exactly three symbols: that interface, the DI token, and a
`createDetachedRunnerMinutes()` factory returning the port type, whose sole production call site
is the initializer of the orchestrator's injector-less fallback backing member required by the
ownership requirement above. The factory SHALL return an instance with the ledger's real recording
semantics, never a no-op double.
The port file SHALL NOT export or re-export the concrete `RunnerMinutesLedger` class. Its vocabulary SHALL stay
runner-scoped (`RunningInterval`, `taskId`) and SHALL NOT import task-execution concepts such
as admission, fences, leases, or the semaphore. Every file this change adds SHALL carry a
classified suffix (`.port.ts`, `.service.ts`, or `.module.ts`); the two pre-existing bare `.ts`
files (`runner-minutes.ts`, `metrics-projection.ts`) SHALL NOT be renamed, moved, or deleted,
because their `unclassified-file` ratchet entries would go stale and turn the r7 comparator red.

#### Scenario: Consumers import the port, never the implementation

- **WHEN** every import of `apps/api/src/runner-metrics/*` made from a file outside that
  directory is listed on the integrated tree, excluding `*.module.ts` composition files
- **THEN** each import originating in a different bounded context names the `*.port.ts` file,
  and zero of them name the owner's `*.service.ts`

#### Scenario: The port surface is exactly the three declared methods

- **WHEN** the port interface is read
- **THEN** it declares `recordStart`, `recordEnd`, and `intervals` and no fourth member, and the
  file's exports are exactly the interface, the DI token, and `createDetachedRunnerMinutes` —
  neither the `RunnerMinutesLedger` class nor any other named implementation type is exported

#### Scenario: The detached factory has exactly one production call site

- **WHEN** `apps/api/src` is searched for `createDetachedRunnerMinutes(` outside test files
- **THEN** exactly one call site is found — the initializer of the orchestrator's fallback backing
  member in `guardrails.service.ts` — so the factory cannot become a second route to owning ledger
  state

#### Scenario: The port carries no task-execution vocabulary

- **WHEN** the port file's text is scanned case-insensitively for `admission`, `fence`, `lease`,
  `semaphore`, and `queued`
- **THEN** zero matches are found, so the interface reads purely in runner-accounting terms

#### Scenario: Added files are classified and the stale-entry trap is not sprung

- **WHEN** `pnpm test:context-layout-v2` and the r7 comparator run on the integrated tree
- **THEN** the gate exits 0, zero new `unclassified-file` keys appear, and the entries
  `unclassified-file:apps/api/src/runner-metrics/runner-minutes.ts` and
  `unclassified-file:apps/api/src/runner-metrics/metrics-projection.ts` are both still present
  with count 1

### Requirement: The metrics reader calls the owner directly and no forwarder survives

`MetricsService` SHALL obtain running intervals from the runner-minutes port and SHALL NOT route
that read through `GuardrailsService`. The orchestrator's forwarding accessor
`runnerMinuteIntervals()` (`guardrails.service.ts:3879-3881`, a one-line delegator) SHALL be
DELETED rather than left behind as an uncalled delegator, and no replacement forwarder SHALL be
introduced on any orchestrator. Every test double that stubbed the forwarder SHALL be restated
against the port in the same commit, so the identifier disappears from the tree entirely.

#### Scenario: The forwarding identifier is gone from the tree

- **WHEN** `apps/api/src` is searched for the identifier `runnerMinuteIntervals` on the
  integrated tree
- **THEN** zero matches are found, in production code and in test doubles alike

#### Scenario: Metrics does not reach runner state through guardrails

- **WHEN** `apps/api/src/metrics/metrics.service.ts` is inspected
- **THEN** `deriveRunnerMinutes` is fed from the injected runner-minutes port, and no expression
  in the file reads runner-minutes state off the guardrails collaborator

#### Scenario: The guardrails cross-context count falls by exactly one while metrics stays put

- **WHEN** the r7 comparator is run against `scripts/ratchets/r7.json` on the integrated tree
- **THEN** `cross-context-import:apps/api/src/guardrails/guardrails.service.ts` reads 8 (down
  from 9, because the ledger import is now a `*.port.ts` import and therefore a legal form),
  `cross-context-import:apps/api/src/metrics/metrics.service.ts` still reads 2 (its
  `semaphoreProjection` dependency on guardrails is out of this change's scope), no recorded
  count rose, and no new key appeared

#### Scenario: No uncalled delegator is left behind

- **WHEN** the guardrails public methods are enumerated and cross-referenced with their call
  sites on the integrated tree
- **THEN** zero methods exist whose body only forwards to the runner-minutes port and which
  have no call site

### Requirement: The derived output is proven unchanged by a characterization test bound to the real implementation

Behavioural equivalence of the derivation SHALL be proven by a characterization test written
BEFORE the ownership move lands, pinning the complete output object of `deriveRunnerMinutes`
over a fixed interval fixture with a frozen `now`, and passing UNMODIFIED after the move. The
test SHALL exercise the REAL implementation (the compiled `runner-minutes` module, the way
`apps/api/src/metrics/metrics.verify.test.mjs` already loads `dist/`), NOT a hand-written inline
mirror: `apps/api/src/metrics/runner-minutes.test.mjs` inlines its own copy of the function
(self-declared at `:13` as a "mirror runner-minutes.ts") and would stay green even if the
implementation moved or broke, so it SHALL NOT be offered as the equivalence proof. The
characterization test SHALL live under `apps/api/src/runner-metrics/` and SHALL NOT be added to
`apps/api/src/guardrails/`, whose 135 `test()` / 6 `*.spec.ts` / 8 `.test.mjs` characterization
baseline is pinned by the guardrails capability.

#### Scenario: The equivalence fixture pins the whole object with a frozen clock

- **WHEN** the characterization test runs over a fixed set of closed and in-flight intervals with
  an injected `now`
- **THEN** it asserts deep equality on the complete `{ available, minutes }` result for each
  fixture, including the empty-fixture case asserting exactly `{ available: false, minutes: null }`
  rather than a fabricated `0`

#### Scenario: The characterization test binds to the real implementation

- **WHEN** the characterization test's imports are inspected
- **THEN** it loads the compiled `runner-minutes` module under test, and asserts nothing against
  a locally re-declared copy of `deriveRunnerMinutes` or of the ledger

#### Scenario: It passes unmodified across the ownership move

- **WHEN** the change's commits are read in order
- **THEN** the characterization test is introduced by a commit that precedes the commit moving
  ownership, no later commit in the change edits that file, and it passes on the integrated tree

#### Scenario: The guardrails characterization baseline is untouched

- **WHEN** the `test()` cases in `apps/api/src/guardrails/*.spec.ts` and the `.test.mjs` scripts
  in that directory are counted on the integrated tree
- **THEN** the counts are still 135 across 6 spec files and 8 `.test.mjs` scripts, so no test
  this change adds landed inside the guardrails baseline

#### Scenario: The new tests are actually discovered

- **WHEN** the repository's test-discovery gate and `pnpm test:scripts` are run on the integrated
  tree
- **THEN** every test file this change adds is reported as executed, not silently skipped

### Requirement: The ownership move adds no runtime behavior and no observable output change

The move SHALL relocate state ownership only. The owner SHALL NOT add logging, persistence,
metrics emission, timers, retries, or error handling that the ledger did not already have — in
particular it SHALL NOT instantiate a `Logger`, so the orchestrator's asserted logger-context
strings stay pinned. The ledger's recorded semantics (idempotent start, no-op end for a task
that never started, clock-skew clamped to zero, closed-then-open snapshot order) SHALL be
unchanged. `GET /metrics` and `GET /tasks/:taskId/metrics` SHALL be unchanged in field names,
types, and values for the same observed intervals, and the change's declared
`unchanged`-on-all-four-surfaces public-surface position SHALL be re-proven by actually running
the adversarial verifier rather than asserted in prose.

#### Scenario: The owner emits no logs of its own

- **WHEN** the owner, the port, and any module file this change adds are searched for `Logger`,
  `console.`, and any injected logger parameter
- **THEN** zero matches are found

#### Scenario: The ledger's recorded semantics are unchanged

- **WHEN** a duplicate `recordStart` for an already-open task, a `recordEnd` for a task that
  never started, and an interval whose `endedAt` precedes its `startedAt` are exercised through
  the port on the integrated tree
- **THEN** the duplicate start is ignored, the unmatched end is a no-op, the skewed interval
  contributes 0 minutes rather than subtracting, and `intervals()` returns closed intervals
  before open ones — identical to the pre-change ledger

#### Scenario: The metrics response body is byte-identical for the same intervals

- **WHEN** the `GET /metrics` response is built from the same interval fixture and the same
  frozen `now` before and after the move
- **THEN** the two response bodies are deep-equal, including the `runnerMinutes` block's
  `available` and `minutes` fields

#### Scenario: The public-surface position is executed, not assumed

- **WHEN** `node scripts/public-surface-adversarial.mjs verify` is run for this change on the
  integrated tree
- **THEN** it exits 0 against the declared `unchanged` status on all four public surfaces with an
  empty `protocolDifferences`, and its output is recorded in the change rather than the
  declaration being taken on trust

