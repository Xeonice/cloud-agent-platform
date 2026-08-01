# test-suite-discovery Specification

## Purpose

Guarantee that a test file which exists is a test file that runs. Mounting is
mechanical — packages discover their suites by pattern, one repository-wide task
covers every workspace package, CI gates on all of them, and a drift check fails
the build when a test file exists that no runner would execute. The alternative,
a hand-maintained list of paths, silently drops whatever nobody remembers to add:
forty files had accumulated behind it in one package alone, including every
security suite, and four of them were red the moment they were finally run.
## Requirements
### Requirement: Test discovery is mechanical, never a hand-maintained list

Every workspace package that owns tests SHALL discover them by pattern (glob or
equivalent directory walk), not by enumerating file paths in a script. Adding a
test file that matches the package's established naming convention SHALL cause
that file to run with no other edit. Package `test` scripts SHALL NOT contain
literal per-file path lists.

This SHALL apply equally to test files that live OUTSIDE a workspace package —
repository-level tooling scripts included. Such tests SHALL be mounted by
pattern through a discovered command, and SHALL NOT be mounted by naming
individual files in a CI workflow: a workflow listing test files is the same
hand-maintained allowlist this requirement forbids in a package script, merely
one level up.

#### Scenario: A newly added test file runs without touching any script

- **WHEN** a contributor adds a test file under a package's conventional test
  location and naming pattern, and changes nothing else
- **THEN** the package's `test` command executes that file
- **AND** no entry was added to any script, workflow, or list to make it run

#### Scenario: A failing assertion in a newly added file fails the package command

- **WHEN** that newly added file contains a failing assertion
- **THEN** the package `test` command exits non-zero

#### Scenario: A repository-level test file runs without being named anywhere

- **WHEN** a contributor adds a test file under the repository's tooling scripts
  directory, matching the established naming pattern, and changes nothing else
- **THEN** the discovered command executes that file
- **AND** no file name was added to a workflow or script to make it run

### Requirement: A repo-wide test task exists and covers every workspace package

The task runner SHALL expose a `test` task so that a single repo-level command
runs the tests of every workspace package that declares one. The task SHALL
declare its upstream build dependency so that packages requiring compiled output
are built first, and packages SHALL NOT re-express that ordering by chaining
build commands inside their own test scripts.

#### Scenario: One command runs the whole graph

- **WHEN** the repo-level test task is invoked on a healthy tree
- **THEN** every workspace package declaring a `test` script runs
- **AND** upstream packages are built before dependents that need their output

#### Scenario: A package test script does not rebuild its dependencies itself

- **WHEN** a package's `test` script is inspected
- **THEN** it does not chain filtered build commands for its dependencies
- **AND** the ordering is expressed once, in the task graph

### Requirement: Every workspace package's tests gate merges

CI SHALL run the tests of every workspace package that declares a `test` script,
including provider and conformance packages. A package owning tests that no CI
job executes SHALL be treated as a defect, not as an intentional exclusion. The
job running these tests SHALL be a required check for merging.

#### Scenario: Sandbox family tests block a merge

- **WHEN** a test in any `packages/sandbox*` package fails
- **THEN** the CI job running package tests exits non-zero
- **AND** the merge is blocked by that required check

#### Scenario: Conformance suites run in CI for first-party providers

- **WHEN** CI runs the package test graph
- **THEN** the provider conformance suites execute for the first-party providers
  that declare provider capabilities

### Requirement: Undiscovered test files fail the build

The repository SHALL expose a check that enumerates test files on disk,
enumerates the files the configured runners would discover, and fails when a
test file exists that no runner would execute. The check SHALL name every
undiscovered file in its output. Any file intentionally excluded SHALL be listed
in an explicit, reviewable exclusion list rather than being silently invisible.

The check's scope SHALL be the REPOSITORY, not only its workspace packages. A
test file outside every workspace package SHALL be enumerated and held to the
same standard, so that a directory the package graph does not cover cannot
become a place where tests accumulate unrun.

#### Scenario: A test file placed outside every discovery pattern is reported

- **WHEN** a test file is added at a path no runner pattern matches, and it is
  not in the exclusion list
- **THEN** the discovery check exits non-zero
- **AND** its output names that file

#### Scenario: An intentionally excluded file is silent but visible

- **WHEN** a test file is present in the explicit exclusion list
- **THEN** the discovery check passes
- **AND** the exclusion remains readable in the list, so review can see it

#### Scenario: The check runs as a merge gate

- **WHEN** a pull request adds an undiscovered test file
- **THEN** a required CI check fails before merge

#### Scenario: A test file outside any workspace package is in scope

- **WHEN** a test file exists outside every workspace package and no command
  would execute it
- **THEN** the discovery check exits non-zero and names it
- **AND** it is not treated as out of scope merely because the package graph does
  not reach it

### Requirement: Standalone compilation harnesses match the repository compiler baseline

A standalone compilation harness SHALL pass the same strictness settings as the
repository's shared compiler baseline when it invokes the TypeScript compiler
directly to prove that a source file compiles. Such a harness SHALL NOT report a
defect that the repository build would not report.

#### Scenario: A standalone compile harness agrees with the project build

- **WHEN** a standalone compilation harness runs against a file that the project
  build compiles cleanly
- **THEN** the harness reports no errors

#### Scenario: A genuine type error is still caught

- **WHEN** a source file contains a type error that violates the shared baseline
- **THEN** the standalone compilation harness exits non-zero

### Requirement: A declared suite runs in some CI lane or is deleted

A test or coverage script a workspace package declares SHALL be invoked by at
least one CI workflow lane, or SHALL be deleted — a complete harness wired into
no workflow is the same defect as an unrun test file, one level up. The known
instances are closed concretely: `test:visual` and `test:terminal-stories` each
run in their own CI lane (the two configs are deliberately separate, since the
visual lane masks live terminal content); `test:cors-headers` SHALL be invoked
by a NAMED `ci.yml` step (indirect coverage through the repository scripts glob
does not make the check a visible gate); `coverage:sandbox`, which has zero
consumers, SHALL be either wired into a lane or removed per 总则4 wire-or-delete.

New lanes SHALL follow the twice-codified convention: run green as non-required
checks first; marking one required is a registered manual GitHub step; no
existing check display name is renamed.

#### Scenario: The visual lane gates in CI

- **WHEN** CI runs on a pull request touching web paths
- **THEN** a workflow lane executes `test:visual`
- **AND** a screenshot comparison exceeding the manifest threshold turns that lane red

#### Scenario: The terminal-stories lane gates in CI

- **WHEN** CI runs on a pull request touching web paths
- **THEN** a workflow lane distinct from the visual lane executes the terminal-stories suite
- **AND** a story that fails to render turns that lane red

#### Scenario: cors-headers has a named step

- **WHEN** `ci.yml` is inspected after this change
- **THEN** a named step invokes `pnpm test:cors-headers` directly
- **AND** a failing cors-headers check turns that step red

#### Scenario: coverage:sandbox has a consumer or does not exist

- **WHEN** workflows, Makefile, and hooks are searched for `coverage:sandbox` after this change
- **THEN** either a CI lane invokes it, or the script no longer exists in `package.json`
- **AND** no third state (declared but unconsumed) remains

#### Scenario: New lanes are non-required first

- **WHEN** the new lanes land
- **THEN** none is flipped to a required status check within this change
- **AND** the manual flip is recorded as a registered follow-up GitHub step

### Requirement: Visual lanes pin their rendering environment and review their baselines

A CI lane that compares rendered screenshots SHALL run inside a PINNED
rendering environment — a pinned Playwright Docker image version — because
baselines generated on a different OS (Mac-generated baselines against Linux
runners) guarantee font-rendering flake. Baselines SHALL be generated inside
the same pinned environment the lane runs in, and SHALL be treated as reviewed
source: committed to the repository, changed only through a reviewable diff.

#### Scenario: The lane and its baselines share one pinned environment

- **WHEN** the visual lane executes in CI
- **THEN** it runs inside the pinned Playwright image version recorded in the workflow
- **AND** the documented baseline-regeneration procedure uses that same pin

#### Scenario: A baseline change is a reviewed diff

- **WHEN** a screenshot baseline changes
- **THEN** the change appears as a committed file diff in the pull request
- **AND** the lane never overwrites baselines from a runner during a gating run

#### Scenario: A rendering regression turns the lane red

- **WHEN** a rendered page diverges from its committed baseline beyond the manifest threshold
- **THEN** the visual lane exits non-zero naming the screen

### Requirement: The quarantine list is empty in the healthy state and owned when not

Every quarantined-suite entry SHALL carry three fields (suite, reason, owning
change) and the quarantine runner SHALL pass on an empty list — the empty list
is the healthy state, and the mechanism is proven on it. Clearing SHALL inherit
the recorded diagnosis rather than repeat it: the three current entries
(install-preflight, stale-sweep-canary, readoption-history) are cleared with
evidence from GitHub runners; the four previously rejected install-preflight
hypotheses SHALL NOT be re-run as the primary line of investigation; the first
step for install-preflight SHALL be adding diagnostic output, since the suite
currently prints PASS/FAIL with zero diagnostics.

#### Scenario: The list returns to empty and the mechanism survives it

- **WHEN** the quarantine takeover completes
- **THEN** `scripts/quarantined-suites.mjs` holds zero entries
- **AND** its paired self-test passes against the empty list

#### Scenario: Diagnosis is inherited, not repeated

- **WHEN** install-preflight is investigated
- **THEN** the first committed step adds diagnostic output to the suite
- **AND** the clearing evidence comes from GitHub runner executions, not local runs
- **AND** none of the four rejected hypotheses (platform, missing curl, Homebrew probing, CI branch) is re-tested as the primary line

#### Scenario: A future quarantine entry is fully attributed

- **WHEN** a suite is quarantined after this change
- **THEN** its entry carries suite, reason, and owning change
- **AND** an entry missing a field fails the quarantine audit

### Requirement: A suite excluded from execution SHALL name an accountable change

A test file that a runner discovers but does not execute SHALL be listed in one
place that states, per entry, what fails, the evidence establishing it, and the
change accountable for returning the suite to the default run. An entry missing
any of the three SHALL fail the suite it was meant to unblock.

Every run SHALL print the excluded suites and their reasons. An exclusion that is
only visible to someone who opens the list is the failure mode this requirement
exists to prevent, not a milder version of it.

The excluded suites SHALL remain runnable on demand through a named command, so
that the list has a path back to empty rather than only a path to growth.

#### Scenario: An undocumented exclusion stops the suite

- **WHEN** an excluded suite is listed without a reason, without evidence, or
  without a change accountable for it
- **THEN** the runner SHALL fail rather than skip the suite, so an unexplained
  skip cannot be the cheap option

#### Scenario: Exclusions are announced on every run

- **WHEN** any suite runs with exclusions in effect
- **THEN** each excluded file SHALL be printed with its reason and its accountable
  change before the run begins

#### Scenario: An exclusion that outlives its file is reported

- **WHEN** an excluded suite is moved or deleted while its entry remains
- **THEN** the runner SHALL fail, so the list cannot accumulate entries for files
  nobody can find

#### Scenario: Excluded suites can be run deliberately

- **WHEN** someone needs to know whether an excluded suite still fails
- **THEN** a named command SHALL run exactly the excluded suites, so releasing one
  does not require reconstructing how to invoke it

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

