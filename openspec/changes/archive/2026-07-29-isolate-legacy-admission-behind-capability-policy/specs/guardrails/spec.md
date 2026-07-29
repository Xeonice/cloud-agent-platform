## ADDED Requirements

### Requirement: Admission mode is chosen by an explicit total policy over the capability gate

Choosing between the durable and legacy admission pipelines SHALL be a single
named policy that consumes the deployment-capability gate's full result, not a
boolean flattening of it. The policy SHALL be a total mapping over the gate's
closed reasons, so that introducing a new closed reason without deciding its
consequence fails to compile rather than silently inheriting a default. A gate
provider that is absent SHALL resolve to its own named outcome, distinct from
every reason a present gate can report. The chosen mode SHALL still be read
exactly once per acceptance and frozen for every later decision including the
transaction write.

This requirement governs how the mode is chosen and what the choice carries. It
does not change which mode is chosen: an unproven capability continues to resolve
to the legacy pipeline.

#### Scenario: A closed gate resolves through the policy carrying its reason

- **WHEN** a task is accepted while the capability gate reports closed with a
  reason such as `deployment_attestation_expired`
- **THEN** the policy SHALL resolve the admission mode to legacy and the resolved
  decision SHALL carry that reason, rather than reducing the gate result to a
  boolean before choosing

#### Scenario: An absent gate provider is distinguishable from a closed gate

- **WHEN** a task is accepted in a context where no admission gate provider is
  wired
- **THEN** the policy SHALL resolve to legacy under a named outcome that is not
  any of the gate's closed reasons, so a dependency-injection regression is not
  reported as a legitimately closed gate

#### Scenario: An open gate resolves to durable admission unchanged

- **WHEN** a task is accepted while the capability gate is open
- **THEN** the policy SHALL resolve the admission mode to durable, and the frozen
  mode SHALL drive the same acceptance, transaction, and diagnostic behaviour as
  before this change

#### Scenario: A new closed reason cannot be added without deciding its consequence

- **WHEN** a closed reason is added to the deployment-capability gate without a
  corresponding entry in the policy
- **THEN** the project SHALL fail to typecheck, rather than compiling and letting
  the new reason inherit an unstated fallback

### Requirement: The legacy admission pipeline sits behind a declared port

The legacy admission pipeline SHALL live outside the guardrails orchestrator in a
directory of its own, and the coupling between them SHALL be explicitly declared
in BOTH directions. That pipeline is the synchronous provisioning and run-start
path taken when the capability gate is not open, together with the helpers that
maintain its state and the process-local state itself — including the parts of
that state which the shared terminal-settlement path reads.

Every guardrails operation the pipeline depends on SHALL be named on a port the
pipeline declares, and every operation the orchestrator invokes on the pipeline
SHALL be named on a port the pipeline declares, so that neither surface can widen
without the widening being written down. No pipeline state SHALL remain reachable
from the orchestrator except through those declarations, so that deleting the
directory leaves no orphaned state behind and the remaining call sites are
reported by the compiler. The extraction SHALL NOT introduce a directory
dependency cycle: the module layout contract's permitted-cycle list SHALL remain
empty.

Behaviour SHALL be preserved exactly. The legacy and durable paths SHALL continue
to share one attempt recorder, stage vocabulary, failure classifier, and cleanup
disposition, and terminal settlement, slot release, cancellation fencing, and
diagnostic settlement SHALL be indistinguishable from their behaviour before the
extraction.

#### Scenario: Guardrails reaches the legacy pipeline only through a declared port

- **WHEN** the guardrails orchestrator drives a task admitted in legacy mode
- **THEN** it SHALL invoke the legacy pipeline through a declared entry port
  rather than through a concrete implementation type, and the pipeline SHALL
  obtain every orchestrator operation it needs from its own declared port rather
  than by reaching into orchestrator internals

#### Scenario: No pipeline state is left behind in the orchestrator

- **WHEN** the legacy pipeline's process-local state is inspected after the
  extraction
- **THEN** every container SHALL live in the extracted directory, and the shared
  terminal-settlement path SHALL reach that state only through the entry port, so
  that removing the directory cannot leave state without an owner

#### Scenario: Existing guardrails behaviour is unchanged by the extraction

- **WHEN** the existing guardrails test suite runs against the extracted structure
- **THEN** every test SHALL pass without being rewritten to accommodate the new
  arrangement, including the terminal-settlement, cancellation, provisioning-
  failure, and slot-release cases

#### Scenario: The extraction does not create a directory cycle

- **WHEN** the module layout gate runs after the legacy pipeline has been moved to
  its own directory
- **THEN** it SHALL report no violation with an empty permitted-cycle list, so the
  new directory and guardrails do not depend on each other outside module
  composition

### Requirement: Degrading to the legacy pipeline is attributable at the point of acceptance

A resolution to the legacy pipeline SHALL record, at the decision point, the
reason the deployment could not prove the durable-admission capability.
Attribution SHALL reuse the existing
capability-status and diagnostic surfaces rather than introducing a new persisted
schema: the read-only deployment-capability endpoint remains the authority for the
gate's current state, and per-attempt diagnostics continue to record the admission
mode.

#### Scenario: A degraded acceptance states which capability was unproven

- **WHEN** an acceptance resolves to legacy because the capability gate is closed
- **THEN** the recorded decision SHALL identify the unproven capability and the
  closed reason, so an operator reading it does not have to independently query
  the gate to learn why this task took the legacy path

#### Scenario: Attribution adds no persisted schema

- **WHEN** the attribution is added
- **THEN** the deployment-capability endpoint response and the persisted
  provisioning-diagnostic schemas SHALL be unchanged
