## MODIFIED Requirements

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
