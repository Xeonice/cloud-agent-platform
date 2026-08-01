## ADDED Requirements

### Requirement: Runtime artifact checksums are keyed by the runtime vocabulary with explicit partial semantics

`RuntimeArtifactChecksumsSchema` SHALL be a record keyed by the declared runtime
vocabulary (`z.record(RuntimeSchema, Sha256ChecksumSchema)`) rather than a strict
literal-key object, and its semantics SHALL be explicitly partial: an attestation
that lacks a checksum for some declared runtime — for example a historical
attestation persisted before a new runtime was declared — MUST continue to
parse. A key outside the runtime vocabulary MUST be rejected, and values MUST
remain validated sha-256 checksums.

`packages/contracts`, `apps/api`, and `apps/web` SHALL construct and consume this
schema through the Zod classic v3 entrypoint only: v4 flips enum-keyed
`z.record` semantics to exhaustive, which would silently break the partial
contract (the future v4 migration path is `z.partialRecord`).

#### Scenario: A historical attestation missing a new runtime's key parses

- **WHEN** a runtime identifier is added to the declaration and a previously
  persisted attestation carries checksums only for `codex` and `claude-code`
- **THEN** the attestation parses successfully and its consumers behave exactly
  as before the new runtime existed

#### Scenario: Existing attestation fixtures parse identically

- **WHEN** the pre-change attestation fixtures (both keys, either key alone, and
  invalid checksum values) are parsed with the record schema
- **THEN** every fixture accepted before is accepted with an identical parsed
  result, and every fixture rejected before (e.g. malformed checksum) is still
  rejected

#### Scenario: A non-vocabulary key is rejected

- **WHEN** an attestation carries a checksum keyed by an identifier that is not
  in the runtime vocabulary
- **THEN** parsing fails rather than accepting or silently dropping the unknown
  key

#### Scenario: No zod/v4 entrypoint import exists in the constrained packages

- **WHEN** the sources of `packages/contracts`, `apps/api`, and `apps/web` are
  scanned for imports of the `zod/v4` subpath
- **THEN** zero such imports are found

### Requirement: The environment source-kind vocabulary has a single declaration with an explicit extension tier

`SandboxEnvironmentSourceKindSchema` in `sandbox-environment.ts` SHALL be the
single declaration of the environment source-kind vocabulary. The runtime-model
side SHALL derive its members from this declaration plus explicitly modeled
extension/legacy members (`provider-snapshot`, `boxlite-rootfs`) rather than
maintaining an independent member list. Managed environment creation and
validation SHALL keep rejecting non-managed source kinds exactly as today — the
extension tier does not widen the managed surface. After the merge, the R5
vocabulary parity gate (`sandbox-core-vocabulary-parity.mjs`) SHALL carry a
`PAIRS` entry covering this vocabulary.

#### Scenario: The derived side cannot drift from the declaration

- **WHEN** the runtime-model source union's kind members are compared against the
  single declaration plus its declared extension members
- **THEN** they reconcile exactly, the R5 parity gate passes, and an injected
  divergence on either side turns the gate red

#### Scenario: Managed creation still rejects non-managed kinds

- **WHEN** a managed environment create or validate request carries
  `provider-snapshot` or `boxlite-rootfs`
- **THEN** it is rejected exactly as before the merge and the environment is not
  selectable for tasks

#### Scenario: The parity gate covers the merged vocabulary

- **WHEN** the R5 gate's `PAIRS` list is inspected after the merge
- **THEN** it contains an entry pairing the source-kind declaration with its
  runtime-model derivation site, and the gate's paired self-test passes
