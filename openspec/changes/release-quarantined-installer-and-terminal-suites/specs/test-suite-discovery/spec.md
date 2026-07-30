## ADDED Requirements

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
