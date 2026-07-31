## ADDED Requirements

### Requirement: Ratchet baselines are shrink-only and fail closed

The repository SHALL provide a tolerated-violation baseline mechanism under
`scripts/ratchets/` for gates that expand over known 存量. A baseline SHALL only
shrink: comparison SHALL fail when the measured violation count EXCEEDS the
baselined count (a new violation), and SHALL equally fail when the measured
count is BELOW the baselined count (a stale entry) — so a fix cannot land
without the matching baseline shrink in the same PR, and a fixed violation can
never silently regrow. When a gate's measured violation count reaches zero, the
baseline file SHALL be deleted; a baseline whose total tolerated count is zero
SHALL itself be reported as a failure rather than kept as an empty shell. The
semantics are the strict fail-on-stale variant (ESLint bulk-suppressions
model), NOT silent auto-reduce.

#### Scenario: A violation above the baseline is red
- **WHEN** a ratcheting gate measures more violations than its committed baseline tolerates
- **THEN** the gate exits non-zero
- **AND** the output names the violations the baseline does not cover

#### Scenario: A stale baseline entry is red
- **WHEN** a violating site is fixed but the baseline entry's count is not shrunk in the same PR
- **THEN** the gate exits non-zero
- **AND** the output names the stale entry and the measured (lower) count it must shrink to

#### Scenario: Reaching zero deletes the baseline
- **WHEN** every violation a baseline tolerates has been eliminated
- **THEN** the baseline file is deleted from `scripts/ratchets/`
- **AND** the gate passes with no baseline present

#### Scenario: A zero-total baseline is itself a failure
- **WHEN** the comparator is given a baseline file whose entries total zero tolerated violations
- **THEN** it exits non-zero telling the operator to delete the file

### Requirement: Baseline entries are count-based data with per-entry ownership

Each baseline entry SHALL carry `{count, samples[], change}`: the tolerated
violation count, illustrative sample locations, and the owning change
responsible for eliminating the entry (e.g. the R3 dockerode files annotated
"阶段 7a 端口化根治"). Comparison SHALL key on COUNT — samples are documentation,
not match keys — so entries survive refactors that move code without changing
how many violations the gate measures. An entry missing any of the three
fields SHALL fail the comparator's audit.

#### Scenario: An unrelated refactor does not break the baseline
- **WHEN** code inside a baselined file moves or is reformatted without changing the number of violations the gate measures
- **THEN** the gate still passes against the unchanged baseline

#### Scenario: A malformed entry is rejected
- **WHEN** a baseline entry lacks `count`, `samples`, or `change`
- **THEN** the comparator exits non-zero naming the malformed entry and the missing field

### Requirement: One shared comparator serves every ratcheting gate

The baseline-comparison semantics SHALL be implemented exactly once, as a
shared module under `scripts/ratchets/`, and every ratcheting gate SHALL
consume that module. A gate SHALL NOT re-implement the comparison loop — later
ratchets (R7/R11/S2 in subsequent phases) reuse the same comparator.

#### Scenario: The comparator has a single implementation
- **WHEN** the repository is searched for baseline-comparison logic (over-count, stale-entry, zero-total handling)
- **THEN** exactly one implementation exists, under `scripts/ratchets/`
- **AND** the R3 gate consumes it by import rather than by copy

### Requirement: Every ratchet ships a paired self-test proving it can go red

Every ratcheting gate SHALL follow the canon gate shape: the check script is
paired with a self-test invoked as `node <script> && node --test
<script>.test.mjs`, and the self-test SHALL prove — against fixtures, without
touching the repository's real baseline — that the comparator goes red on (a)
a count above baseline, (b) a stale entry, (c) a malformed entry, and (d) a
zero-total baseline.

#### Scenario: The self-test exercises every red path
- **WHEN** the ratchet's self-test runs
- **THEN** it asserts a non-zero outcome for each of the over-count, stale-entry, malformed-entry, and zero-total fixtures
- **AND** it passes without modifying any committed baseline file
