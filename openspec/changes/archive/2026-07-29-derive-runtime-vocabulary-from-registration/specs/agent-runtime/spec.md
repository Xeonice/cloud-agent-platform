## ADDED Requirements

### Requirement: The set of runtime identifiers SHALL be declared exactly once

The identifiers naming the agent runtimes a deployment can run SHALL exist as a
single declaration, and every other statement of that set — the request/response
validation schema, the type the runtime registry keys by, and the default runtime
— SHALL be derived from it rather than written independently.

No statement of the set SHALL rely on a comment, convention, or review to stay in
agreement with another. The read endpoint that publishes which runtimes exist
SHALL NOT validate its own response against a set that is narrower than the
declaration.

#### Scenario: The wire schema and the registry's key type come from one source

- **WHEN** the runtime identifier set is inspected across the shared contract and
  the api
- **THEN** the validation schema and the registry's identifier type SHALL both
  resolve to the same single declaration, so no edit can change one without
  changing the other

#### Scenario: The readiness endpoint can report a newly declared runtime

- **WHEN** a runtime identifier is added to the declaration and an implementation
  is registered for it
- **THEN** the readiness endpoint SHALL be able to report that runtime without a
  further edit to its response schema

#### Scenario: The default runtime is one value, not one per vocabulary

- **WHEN** the default runtime is resolved on either side of the contract boundary
- **THEN** both SHALL resolve the same declared value, derived from one definition
  rather than asserted separately against separate copies of the set

### Requirement: A declared runtime without a registered implementation MUST fail to compile

Registration SHALL be reconciled with the declaration by the type system. Adding
an identifier to the declaration without supplying an implementation, or supplying
an implementation outside the declaration, MUST fail the project's typecheck
rather than being detected at boot, at task launch, or by a reader.

The guard SHALL be proven by a compile-fail fixture that self-invalidates: if the
registration mapping is later weakened to a partial or index-signature shape, the
ordinary typecheck SHALL fail rather than the fixture silently passing.

#### Scenario: Declaring an identifier without registering an implementation

- **WHEN** an identifier is added to the runtime declaration and no implementation
  is registered for it
- **THEN** the project SHALL fail to typecheck, naming the missing identifier

#### Scenario: The guard cannot be weakened without notice

- **WHEN** the registration mapping is changed to a shape that no longer requires
  an entry per declared identifier
- **THEN** the ordinary typecheck SHALL fail, so the weakening cannot land as a
  quiet edit

### Requirement: Admitting a third runtime SHALL cost only a declaration and a registration

The cost of admitting an additional agent runtime SHALL be one entry in the
declaration and one registered implementation. No further edit SHALL be required
to the validation schema, the identifier type, the readiness response shape, or
the persistence layer in order for that runtime to be accepted, resolved, and
reported.

Behaviour for the runtimes that exist today SHALL be unchanged: the same
identifiers SHALL be accepted, the same values rejected, and every wire shape
SHALL be identical to its shape before this requirement was introduced.

#### Scenario: The admission cost is measured rather than assumed

- **WHEN** an additional runtime identifier is introduced and the compiler is
  asked what else must change
- **THEN** the demanded edits SHALL be limited to supplying its implementation,
  and any further demanded edit SHALL be treated as a defect in this boundary
  rather than accepted as necessary

#### Scenario: Existing runtime behaviour is unchanged

- **WHEN** the existing suites run against the derived vocabulary
- **THEN** every test SHALL pass without being rewritten, and the accepted and
  rejected identifier sets SHALL be identical to before
