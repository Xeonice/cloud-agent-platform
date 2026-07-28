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

#### Scenario: A newly added test file runs without touching any script

- **WHEN** a contributor adds a test file under a package's conventional test
  location and naming pattern, and changes nothing else
- **THEN** the package's `test` command executes that file
- **AND** no entry was added to any script, workflow, or list to make it run

#### Scenario: A failing assertion in a newly added file fails the package command

- **WHEN** that newly added file contains a failing assertion
- **THEN** the package `test` command exits non-zero

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
