# test-suite-discovery Delta — deflake environment-dependent suites

## ADDED Requirements

### Requirement: Environment-dependent suite failures are resolved at root cause, never contained

An environment-dependent red suite SHALL be returned to deterministic green by
fixing the defect in the test or fixture itself. Retry, loosening an assertion
so a case passes, deleting the suite, and quarantine containment SHALL NOT
constitute resolution. The fix SHALL live entirely on the test/fixture side:
tested product runtime semantics SHALL have zero diff, and product source SHALL
NOT gain new injection seams solely to serve these tests.

#### Scenario: No retry mechanism is introduced

- **WHEN** the three modified files
  (`packages/sandbox-provider-aio/test/aio-terminal-session-ownership.test.mjs`,
  `packages/sandbox-provider-boxlite/test/boxlite-client.test.mjs`,
  `packages/sandbox-conformance/src/generated-private-git-fixture.ts`) are
  inspected after the change
- **THEN** none of them contains a loop or wrapper that re-invokes a failed test
  case until it passes
- **AND** no runner configuration, workflow, or script gained a retry flag for
  these suites

#### Scenario: The quarantine list remains empty

- **WHEN** `scripts/quarantined-suites.mjs` is inspected after the change
- **THEN** it still holds zero entries
- **AND** none of the three target suites appears in any quarantine, skip, or
  exclusion list

#### Scenario: Tested product semantics carry zero diff

- **WHEN** the change's diff outside `docs/` and `openspec/` is inspected
- **THEN** the only `src/` file modified is
  `packages/sandbox-conformance/src/generated-private-git-fixture.ts` (a test
  fixture, not product runtime)
- **AND** `packages/sandbox-provider-aio/src` and
  `packages/sandbox-provider-boxlite/src` are byte-identical to before the
  change
- **AND** the behavior of `releaseAioTerminalGuestPairExact` and
  `classifySandboxCommandExecutionRejection` is unchanged

#### Scenario: Assertions keep their asserted outcomes

- **WHEN** each formerly flaky assertion is compared before and after the fix
- **THEN** the asserted outcome value is unchanged (the same classification,
  the same released state, the same ACK set) — only the mechanism that reaches
  the assertion became deterministic
- **AND** no numeric time budget was widened as the means of making a
  wall-clock race pass

### Requirement: Time-budget tests control time through stubs, existing seams, or deterministic synchronization points

A test that asserts time-budget or deadline behavior SHALL NOT depend on real
wall-clock margins tight enough to lose a race on a loaded machine. It SHALL
either stub the clock the test reads, drive an existing product injection seam,
or replace the race with an explicit synchronization point on an observable
event. Where a real `setTimeout` in product source cannot be controlled by a
`Date.now` stub, the test SHALL use a synchronization point, not a larger
real-time budget.

#### Scenario: The AIO ownership suite's four wall-clock assertions share one clock helper

- **WHEN** `packages/sandbox-provider-aio/test/aio-terminal-session-ownership.test.mjs`
  is inspected after the change
- **THEN** a single shared `Date.now` stub helper exists in the file (extracted
  from the two pre-existing inline stub precedents, formerly at lines
  1419/2160)
- **AND** all four wall-clock tight-margin assertions (formerly at lines
  1279, 2281, 2760, 3313) consume that helper — zero of the four still reads
  the real clock for its margin

#### Scenario: The two AIO race cases await events instead of real-time budgets

- **WHEN** the "'sent' undefined" case (formerly line 1856, a 10ms real budget
  racing `socketFactory`) and the staged ACK ordering case (formerly line 1941)
  execute
- **THEN** each awaits a deterministic synchronization point (socket-creation /
  ACK observation) before asserting
- **AND** neither case's pass depends on a real-time budget elapsing before or
  after an uncontrolled real `setTimeout` (product source line ~1362)

#### Scenario: The staged ACK assertion matches the state machine's promised ordering

- **WHEN** the staged ACK assertion is compared with the ordering semantics the
  ownership state machine actually promises (the `releaseAioTerminalGuestPairExact`
  region, formerly around line 316 of the product source)
- **THEN** the assertion is order-pinned if and only if the state machine
  guarantees emission order; otherwise it asserts the exact ACK set
  order-insensitively
- **AND** the assertion is not weaker than the promised semantics (no subset or
  count-only check)

#### Scenario: The BoxLite native-exec budget test drives the existing manual deadline driver

- **WHEN** `packages/sandbox-provider-boxlite/test/boxlite-client.test.mjs` is
  inspected after the change
- **THEN** the former 1ms-real-clock native-exec budget test (formerly lines
  795-800) is replaced by tests that pass a manual
  `nativeExecutionDeadlineDriver` to the `execWithPoll` factory through the
  pre-existing product seam (`boxlite-client.ts` lines 165-168, 351-352,
  2280-2354 — no new seam added)
- **AND** no test in the file still selects a native-exec classification path
  via a real clock

#### Scenario: Both BoxLite classification exits are pinned by separate deterministic assertions

- **WHEN** the replacement BoxLite tests run
- **THEN** one assertion drives poll-budget exhaustion and observes the
  `'indeterminate'` classification (the polling-loop break path)
- **AND** a separate assertion drives the deadline trigger and observes the
  `'timeout'` classification (the pre-check path)
- **AND** both assertions pass on every run without depending on host timing

### Requirement: Fixture write paths tolerate whitelisted disconnect errors while preserving failability

The generated private git fixture SHALL survive a git client hanging up early —
normal smart-HTTP protocol behavior — on both of its write paths. Each writable
stream (`child.stdin` and the CGI response) SHALL have an `'error'` listener
attached at stream acquisition time, before any write is attempted (guarding
only the write callback is insufficient — node #11918). The listener SHALL
swallow only errors whose `code` is on an explicit whitelist (`EPIPE`,
`ECONNRESET`); any other error SHALL propagate. The fix SHALL be made in the
fixture's `src`, with the compiled `dist` rebuilt through the task graph.

#### Scenario: An early client hang-up no longer crashes the fixture

- **WHEN** a simulated git client disconnects before the fixture writes to
  `child.stdin` (formerly line 867: `child.stdin?.end()` against a dead child)
  or to the CGI response
- **THEN** the fixture process survives with no `uncaughtException`
- **AND** the fixture remains able to serve a subsequent request in the same
  test process

#### Scenario: A non-whitelisted error still propagates

- **WHEN** an injection-probe-style negative test injects a write error whose
  `code` is not on the whitelist into either write path
- **THEN** the error surfaces to the test (the fixture does not swallow it)
- **AND** that negative test exists in the change and runs in the default suite

#### Scenario: The src fix reaches the dist that gates merges

- **WHEN** `packages/sandbox-conformance/src/generated-private-git-fixture.ts`
  is modified and the repo test graph runs
- **THEN** the compiled `dist` consumed by `test:public-surface` (the required
  public-surface-parity job) is rebuilt via the turbo `dependsOn
  ["build", "^build"]` edge before tests execute
- **AND** the three paired fixture self-tests
  (`apps/api/test/generated-private-git-fixture.test.mjs`,
  `apps/api/test/generated-private-git-boxlite-native.test.mjs`,
  `packages/sandbox-conformance/test/sandbox-conformance.test.mjs` fixture
  block, formerly lines 1839-1881) all pass

### Requirement: A deflake fix is proven by reproduction before and repetition after, under contention

Each targeted failure SHALL be reproduced locally before the fix, under
constrained cores plus competing load (e.g. `taskset -c 0` with `stress-ng`),
against the real CI entry commands
(`pnpm turbo test --filter='./packages/*' --continue` and the affected
package's `node --test --test-force-exit` invocation). After the fix, the same
suite under the identical contention recipe SHALL pass at least 10 consecutive
repetitions with zero failures. Evidence SHALL be recorded per flake in
`tasks.md` in the established format: GitHub run/job ID of an observed CI
failure, root cause, and the local reproduction mechanism.

#### Scenario: Each failure shape is reproduced before the fix

- **WHEN** the pre-fix suites run under the contention recipe against the CI
  entry commands
- **THEN** each of the three registered failure shapes (F.2 wall-clock /
  'sent'-undefined / ACK-order, F.3 native-exec misclassification, F.4 fixture
  `uncaughtException` on early disconnect) is observed at least once
- **AND** the reproduction command line and observed failure are recorded in
  `tasks.md`

#### Scenario: The fixed suites are green under the same contention

- **WHEN** each fixed target suite runs under the identical contention recipe
- **THEN** it passes at least 10 consecutive repetitions with zero failures
- **AND** the repetition count and command are recorded in `tasks.md`

#### Scenario: CI-runner evidence is recorded per flake

- **WHEN** `tasks.md` is inspected after completion
- **THEN** each of F.2, F.3, F.4 has an evidence entry containing a GitHub
  run/job ID, the root cause, and the local reproduction mechanism
- **AND** F.4's entry additionally references the deterministic adversarial
  simulation (early client disconnect) rather than only contention runs

### Requirement: Registered flake entries flip to resolved with the fix

The registry entries that deferred these flakes SHALL be flipped from
"recorded, deferred to a later change" to resolved by the same change that
fixes them, so the registry cannot state an open debt the tree no longer
carries.

#### Scenario: F.2/F.3/F.4 registry entries state resolved

- **WHEN** `docs/refactor/04-rules-registry.md` is inspected after the change
- **THEN** the F.2 (aio-terminal-session-ownership), F.3 (boxlite-client), and
  F.4 (generated-private-git-fixture) entries each carry a resolved status
  naming this change
- **AND** none of the three still defers its fix to a future change
