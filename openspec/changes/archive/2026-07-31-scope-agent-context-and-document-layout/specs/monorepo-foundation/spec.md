## ADDED Requirements

### Requirement: CI jobs SHALL run when a change can affect them

A CI job whose subject is unambiguously confined to part of the repository SHALL
NOT run for changes that cannot reach that part. Jobs whose subject spans the
repository, or that exercise more than one part together, SHALL continue to run
unconditionally.

A condition SHALL NOT be accepted on the evidence that the workflow parses or that
a run is green. A filter that never matches makes a job a no-op reporting success,
which is indistinguishable from a pass. Each conditioned job SHALL be demonstrated
both to run when it should and to be skipped when it should be.

A conditioned job SHALL remain compatible with the branch protection
configuration. A required check that is skipped rather than reported blocks merges
permanently, which is the same class of silent failure in the opposite direction.

#### Scenario: A change that cannot reach a job's subject does not run it

- **WHEN** a change touches only documentation, or only the console
- **THEN** the jobs whose subject is the api or the database SHALL be skipped

#### Scenario: A change that can reach a job's subject still runs it

- **WHEN** a change touches the api or its database schema
- **THEN** every job whose subject it can affect SHALL run, unchanged from before

#### Scenario: A condition is proven in both directions

- **WHEN** a job gains a condition
- **THEN** acceptance SHALL include an observed run and an observed skip for that
  job, rather than the workflow merely parsing
