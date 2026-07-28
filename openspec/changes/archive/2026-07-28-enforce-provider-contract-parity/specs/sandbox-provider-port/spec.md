## MODIFIED Requirements

### Requirement: Capability vocabulary distinguishes provider features from CAP operations

The system SHALL maintain capability names for provider features such as command execution, interactive terminal transport, archive workspace transfer, retained transcript source, readoption, snapshot, sleep, and port exposure, while preserving operation-level required-capability helpers for CAP workflows. The scheduler SHALL match on capabilities rather than concrete provider class names.

Each capability SHALL have exactly ONE internal spelling. A capability SHALL NOT
be expressed under two names that comparison sites must reconcile; where a
deprecated spelling must remain accepted for compatibility, it SHALL be
normalized to the canonical spelling at a SINGLE boundary and SHALL NOT exist
beyond it.

The distinction between provider-feature and CAP-operation capabilities SHALL be
TOTAL: every capability SHALL be classified, and the classification SHALL be the
source from which the vocabulary lists derive rather than a set of lists
maintained alongside it. Introducing a capability without classifying it SHALL
be a compile error. No hand-maintained copy of the vocabulary SHALL be the only
thing verifying the vocabulary.

#### Scenario: Provider feature capabilities compose into operation requirements
- **WHEN** CAP provisions an interactive task with workspace materialization
- **THEN** the planner resolves that operation into the required provider feature capabilities before selecting a provider

#### Scenario: Provider class checks are not used for selection
- **WHEN** AIO and BoxLite are both registered
- **THEN** selecting a provider for a task depends on declared capabilities, priority, and location preference, not on `instanceof` checks or provider names

#### Scenario: One capability has one internal spelling
- **WHEN** the capability vocabulary is inspected for two names denoting the same capability
- **THEN** none exist
- **AND** no comparison site treats one capability name as satisfying a requirement for another

#### Scenario: A deprecated spelling is accepted at the boundary only
- **WHEN** an operator's configuration declares a capability under a deprecated spelling
- **THEN** the provider's effective capability set is identical to the one produced by the canonical spelling
- **AND** the deprecated spelling does not appear in the resolved set

#### Scenario: An unclassified capability does not compile
- **WHEN** a capability is added to the vocabulary without being classified as a provider feature or a CAP operation
- **THEN** compilation fails
- **AND** the vocabulary lists cannot disagree with the vocabulary, because they derive from the classification

## ADDED Requirements

### Requirement: Provider identity has a single declaration

The set of provider families SHALL be declared exactly ONCE, and every schema,
validation, and decision that depends on which providers exist SHALL derive from
that declaration. A provider family list SHALL NOT be restated independently.

Where a surface legitimately admits a value outside the shared set — such as a
diagnostic emitted before a provider is selected — it SHALL be expressed as an
explicit extension of the shared declaration, so that the widening is visible
rather than hidden in a separately maintained list. Where a surface legitimately
covers only a SUBSET of providers, it SHALL be expressed as an explicit subset of
the shared declaration together with the reason, rather than as an independent
list that merely happens to be shorter.

A decision that must produce a value for every provider family SHALL be
expressed as a total mapping, so that introducing a provider is a compile error
at each site that must decide something for it.

#### Scenario: Adding a provider family fails the build at every decision point
- **WHEN** a new member is added to the provider-family declaration
- **THEN** compilation fails at every total mapping that must produce a value for it until each supplies one
- **AND** no schema silently continues to describe the previous set

#### Scenario: Provider-family schemas agree by construction
- **WHEN** the provider-family schemas are compared
- **THEN** their members are the shared declaration, plus only those extensions each states explicitly
- **AND** no schema carries a hand-written member list that can drift from the declaration

### Requirement: Conformance participation is derived from declared capabilities

The conformance families a provider is required to run SHALL be derived from the
capabilities that provider DECLARES, not chosen by the author of its test. A
provider that declares a capability whose conformance family is not exercised
SHALL fail.

Where a capability is exercised INDIRECTLY — by a shared implementation the
provider delegates to rather than by a provider-specific scenario — that
arrangement SHALL be stated explicitly as the coverage for that capability.

Where a capability has NO conformance scenario at all, that gap SHALL be
ENUMERATED as data alongside the mapping, naming the capability. Such a
capability SHALL NOT be demanded of a provider, and SHALL NOT be silently
skipped either: the enumeration is what turns it from an absence nobody can see
into a debt that is written down. An absent MAPPING ENTRY SHALL NOT read as
coverage — every capability SHALL resolve to a scenario family, a stated shared
coverage, or a stated gap.

Conformance participation SHALL be enforced by an executable ledger that derives
the required families from the provider's declared capabilities and FAILS the
provider's conformance run when a required family did not run. The obligation
SHALL NOT be restated by the provider's test — the test declares which family
each suite it builds belongs to, and what is REQUIRED is computed from the
declaration alone, so a family cannot be dropped by simply not mentioning it.

#### Scenario: Declaring a capability requires exercising it
- **WHEN** a provider declares a capability
- **THEN** the conformance family covering that capability runs for that provider
- **AND** the provider's conformance run FAILS if that family did not run, naming the capability and the family

#### Scenario: A capability that is not declared is not demanded
- **WHEN** a provider does not declare command execution
- **THEN** command-output conformance is not required of it
- **AND** its conformance result is unaffected by that family's absence

#### Scenario: Indirect coverage is stated, not inferred
- **WHEN** a capability is covered by a shared implementation's conformance rather than a provider-specific scenario
- **THEN** that is recorded as the explicit coverage for the capability

#### Scenario: A capability with no scenario is an enumerated gap, not a silent pass
- **WHEN** a capability has no conformance scenario in any family
- **THEN** it appears in the enumerated gap list naming the capability
- **AND** a provider declaring it is not failed for the missing scenario
- **AND** a capability that appears in NEITHER the family mapping nor the gap list fails, so a new capability cannot enter the vocabulary uncovered and unrecorded
