## ADDED Requirements

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
