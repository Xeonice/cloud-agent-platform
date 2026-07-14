# adversarial-spec-verify Specification

## Purpose
TBD - created by archiving change enhance-openspec-with-workflows. Update Purpose after archive.
## Requirements
### Requirement: Requirement-level verification unit
The verify flow SHALL treat each spec REQUIREMENT (and its scenarios) as the unit of verification, not implementation tasks. It MUST enumerate every requirement across `specs/**/spec.md` for the change.

#### Scenario: Every requirement is enumerated
- **WHEN** verify runs for a change
- **THEN** each requirement in the change's specs has a corresponding verdict in the report

### Requirement: Static triage with high-risk dynamic escalation
The verify flow SHALL first run a static triage agent per requirement (read requirement, trace to code, emit verdict with confidence and risk). Requirements that are uncertain OR high-risk SHALL be escalated to dynamic verification, where an agent writes and runs a test exercising the scenario. Low-risk, high-confidence "met" requirements MAY pass on the single static verdict.

#### Scenario: Low-risk requirement passes on static verdict
- **WHEN** a requirement is judged met with high confidence and low risk
- **THEN** it is accepted without dynamic verification

#### Scenario: High-risk requirement is dynamically verified
- **WHEN** a requirement is high-risk (touched by multiple tracks, security, or data-mutating) or the static verdict is uncertain
- **THEN** a dynamic check is executed that runs code or a generated test for that requirement's scenario

### Requirement: Adversarial refutation by diverse perspectives
For escalated requirements, the verify flow SHALL dispatch multiple skeptic agents prompted to REFUTE the claim that the requirement is satisfied, each using a distinct lens (correctness, boundary/exception, data integrity, reproducibility, cross-track integration). A requirement is marked verified only if it survives refutation by a majority.

#### Scenario: Only survivors are marked verified
- **WHEN** skeptic agents attempt to refute a requirement
- **THEN** the requirement is marked verified only if a majority fail to refute it
- **AND** a requirement refuted by a majority is recorded as unmet

#### Scenario: Cross-track regression is checked
- **WHEN** a requirement was satisfied by one track but a shared file was later changed by another track
- **THEN** the cross-track-integration skeptic flags the resulting regression

### Requirement: Three-way findings routing
The verify flow SHALL route findings into exactly three destinations: confirmed-unmet requirements become new tasks appended to `tasks.md`; spec-defect findings (ambiguous, untestable, or contradictory requirements) are flagged for `design.md`/specs revision and NOT sent back to apply; confirmed-met requirements are recorded in a `verification-report.md`.

#### Scenario: Unmet requirement reopens a task
- **WHEN** a requirement is confirmed unmet
- **THEN** a corresponding task is appended to `tasks.md` as incomplete

#### Scenario: Spec defect routes to design, not apply
- **WHEN** a requirement is found ambiguous, untestable, or contradictory
- **THEN** it is flagged for spec/design revision and no implementation task is created for it

### Requirement: Completeness and scope checks
The verify flow SHALL include a gap check (a requirement with no corresponding implementation at all) and a scope-creep check (implemented behavior not required by any requirement).

#### Scenario: Missing implementation is detected
- **WHEN** a requirement has no traceable implementation in the codebase
- **THEN** it is reported as a gap, distinct from "implemented incorrectly"

#### Scenario: Out-of-scope behavior is flagged
- **WHEN** implemented behavior maps to no requirement
- **THEN** it is flagged as scope creep for review

### Requirement: Verify gates archive
The verify flow SHALL act as a precondition for archiving. The archive step MUST NOT finalize a change while verify reports any confirmed-unmet requirement.

#### Scenario: Archive blocked on unmet requirements
- **WHEN** archive is attempted and verify reports confirmed-unmet requirements
- **THEN** archive is blocked and the unmet requirements are surfaced

#### Scenario: Archive proceeds when verified
- **WHEN** verify reports all requirements met (or only spec-defect flags pending separate revision)
- **THEN** archive is allowed to proceed

### Requirement: Public-surface changes require dynamic conformance verification

The verify flow SHALL classify any requirement that changes the public capability
registry, canonical public schema, Public V1 binding, MCP adapter, OpenAPI
projection, or Playground projection as high-risk and dynamically verify it; the
requirement MUST NOT pass on static inspection alone. Verify SHALL compare
`surface-impact.json`, the
canonical registry, actual reflected REST handlers, actual SDK MCP tools, and
observable adapter behavior, including every declared exclusion and projection.

#### Scenario: Typecheck passes but MCP strips a field

- **WHEN** the repository builds but the actual MCP callback drops a canonical
  request field before calling the shared use case
- **THEN** dynamic cross-transport conformance marks the requirement unmet
- **AND** the finding reopens an implementation task

#### Scenario: A declared exclusion is false

- **WHEN** a sidecar claims a capability is protocol-excluded but the registry or
  implementation exposes a partial undeclared mapping
- **THEN** verify reports a specification/impact defect rather than accepting the
  exclusion as self-authenticating

#### Scenario: Surface impact is undeclared

- **WHEN** code or registry evidence shows Public V1 or MCP behavior changed but
  `surface-impact.json` marks that surface unchanged or omits it
- **THEN** verify reports an undeclared-impact finding and archive remains gated

