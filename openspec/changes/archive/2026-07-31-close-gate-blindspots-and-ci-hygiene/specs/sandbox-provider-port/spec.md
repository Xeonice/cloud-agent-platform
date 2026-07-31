## MODIFIED Requirements

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

The SET of packages the parity check runs against SHALL itself be DISCOVERED,
never hand-maintained: participation is derived from package capability — a
package whose tests build the conformance suite — through a recursive scan of
the workspace, not from a hardcoded directory list and not from a name glob
that encodes today's package names (a literal `sandbox-provider-*` pattern
would silently drop `sandbox-cloud-http`). A discovery pass that matches ZERO
packages SHALL exit non-zero. A new provider package whose tests build
conformance SHALL enter the parity check with no registration step — this is
what makes the parity promise enforceable for fork and third-party provider
packages.

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

#### Scenario: Parity participation is discovered from capability, not enumerated
- **WHEN** the parity check computes the set of packages to run against
- **THEN** the set is produced by recursive discovery over which packages' tests build the conformance suite
- **AND** the check script contains no hand-maintained directory list of participants

#### Scenario: Discovery that matches nothing is a failure
- **WHEN** the discovery pass finds zero participating packages (e.g. a glob typo or a directory move)
- **THEN** the parity check exits non-zero instead of passing on an empty set

#### Scenario: A new provider package enters parity with no registration
- **WHEN** a new package whose tests build the conformance suite is added to the workspace, and nothing else is edited
- **THEN** the parity check runs against it on the next invocation
- **AND** no edit to the check script or any list was needed

#### Scenario: The capability predicate keeps non-conforming names
- **WHEN** discovery runs on the current workspace
- **THEN** the discovered set includes `packages/sandbox-cloud-http` alongside the `sandbox-provider-*` packages
- **AND** test files in nested subdirectories of a participant are found (discovery is recursive, not a single-level directory read)

#### Scenario: The discovery gate can go red
- **WHEN** a probe violation is introduced in a discovered package (e.g. a nominated symbol change that breaks conformance compilation)
- **THEN** the parity check fails naming the package
- **AND** the probe is reverted with the red run recorded as evidence

## ADDED Requirements

### Requirement: The provider-center facade exposes an explicit reviewed export surface

The public entry of `@cap-console/sandbox` SHALL enumerate its exports by NAME.
Wildcard re-export (`export *`) SHALL NOT appear in the facade entry module —
a barrel of `export *` lines leaks every provider internal through the center
boundary. The exported surface SHALL be enforced by a surface gate that
compares the MEASURED surface (derived from the module) against COMMITTED
reviewed surface data, and the two sides SHALL NOT reference each other — a
gate whose expected side is derived from the same source it measures attests
itself and can never fail (the converge-contracts blind spot).

Provider-internal symbols that ratcheted `apps/api` consumers (the taskless
probe and the sandbox-environments validator) still reach through the facade
SHALL be tolerated only as ENUMERATED whitelist entries annotated with
phase-7a ownership. The healthy end state of that tolerated list is empty.

#### Scenario: The facade contains no wildcard re-exports
- **WHEN** the facade entry module of `@cap-console/sandbox` is scanned
- **THEN** it contains only named export statements
- **AND** introducing an `export *` line makes the surface gate exit non-zero

#### Scenario: An unreviewed surface change is red
- **WHEN** an export is added to or removed from the facade without the committed surface data being updated in the same PR
- **THEN** the surface gate exits non-zero naming the diverging symbol

#### Scenario: Tolerated provider internals are enumerated with ownership
- **WHEN** a provider-internal symbol remains exported for a ratcheted `apps/api` consumer
- **THEN** it appears as an explicit whitelist entry carrying a reason and phase-7a ownership annotation
- **AND** the R6 landing is green — the whitelist carries the symbols those consumers import, rather than breaking them

#### Scenario: The surface gate cannot self-attest
- **WHEN** the gate's self-test injects a new export while leaving the committed surface data untouched
- **THEN** the gate goes red
- **AND** the probe is reverted with the red run recorded as evidence, proving the expected side is not regenerated from the module at check time

### Requirement: Zero-reference forwarding stubs are removed with proof

A facade-package module SHALL be deleted, not shipped, when no importer
references it and the package's `exports` map cannot resolve it: the `files` field
publishes `src/`, so dead stubs currently reach the tarball. The six pure
re-export stubs in `packages/sandbox/src` (capabilities, provider, lifecycle,
registry, scheduler, workspace-git forwarders) SHALL be removed with a
zero-reference proof, and the R3 ratchet baseline SHALL NOT absorb deleted
stubs as 存量.

#### Scenario: The stubs are deleted with zero-reference proof
- **WHEN** the repository (apps, packages, scripts) is searched for importers of the six forwarding stubs
- **THEN** zero references are found and the search evidence is recorded
- **AND** the stub files no longer exist in `packages/sandbox/src`

#### Scenario: The ratchet baseline does not tolerate dead files
- **WHEN** the R3 baseline in `scripts/ratchets/` is inspected after the deletion lands
- **THEN** no baseline entry references a deleted stub path

### Requirement: Published subpaths resolve only from declared runtime dependencies

No published subpath of `@cap-console/sandbox` SHALL re-export from a package
that appears only in `devDependencies`. The current `./testing` leak
(re-exporting `createGeneratedPrivateGitFixture` from
`@cap-console/sandbox-conformance`, a devDependency) SHALL be 归位 by exactly
one of: promoting conformance to a real dependency, or removing the re-export
so the two consuming `apps/api` specs import conformance directly (P3 already
permits devDep conformance for tests).

#### Scenario: The testing subpath has no devDependency leak
- **WHEN** the modules reachable from each entry in the package's `exports` map are resolved against the package's declared `dependencies`
- **THEN** every import resolves — no reachable module imports a package absent from `dependencies`

#### Scenario: The fixture consumers keep working through a dependency-correct path
- **WHEN** the two `apps/api` spec files that consume the generated-private-git fixture run
- **THEN** they pass, importing the fixture either from a promoted real dependency or directly from `@cap-console/sandbox-conformance`
