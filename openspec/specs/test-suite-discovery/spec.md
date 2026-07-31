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

