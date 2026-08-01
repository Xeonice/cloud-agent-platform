# security-seam-assertions — delta

## ADDED Requirements

### Requirement: The four security seams are asserted to exist

A gate SHALL assert the existence of the four D-table security seams at their
declared paths: the request-origin single computation
(`apps/api/src/auth/request-origin.ts`), the unified REST/WS session-validation
entry points, `assertSafeProviderUrl`
(`apps/api/src/settings/assert-safe-provider-url.ts`), and the credential
encryption/decryption helper (`apps/api/src/crypto/secret-storage.ts`). A
missing or relocated seam file SHALL fail the gate.

#### Scenario: A healthy tree passes

- **WHEN** the gate runs on a tree where all four seam files exist at their
  declared paths and each uniqueness predicate holds
- **THEN** the gate exits zero

#### Scenario: A missing seam file is red

- **WHEN** any declared seam file is absent from its declared path and the
  gate runs
- **THEN** the gate exits non-zero naming the missing seam and its expected
  path

### Requirement: Each seam has a uniqueness predicate proving a single implementation

Each seam entry SHALL carry a uniqueness predicate — the symbol or computation
that must be defined exactly once (e.g. `decryptStored`,
`assertSafeProviderUrl`, the request-origin computation) — and the gate SHALL
scan the governed tree to prove exactly one implementation exists, per the
"one list, not two" rationale. A duplicate implementation SHALL fail the gate.

#### Scenario: A duplicate seam implementation is red

- **WHEN** a second definition of a seam's unique symbol is introduced anywhere
  in the governed tree and the gate runs
- **THEN** the gate exits non-zero naming both the canonical and the duplicate
  location

#### Scenario: Consumers importing the seam do not trip uniqueness

- **WHEN** governed files import and call a seam's symbol without redefining it
- **THEN** the gate still counts exactly one implementation and passes

### Requirement: The seam list is manifest data, not gate-embedded

The gate SHALL read the seam entries (paths and uniqueness predicates) from the
D-table entries of `docs/refactor/boundaries-manifest.json`. The gate script
SHALL NOT embed its own copy of seam paths or predicates, and it SHALL fail
closed when the manifest is missing or yields an empty seam set.

#### Scenario: The gate consumes the manifest's D entries

- **WHEN** the gate script is inspected
- **THEN** its seam paths and uniqueness predicates come from parsing the
  boundaries manifest, with no hardcoded duplicate of that data in the script

#### Scenario: An empty seam set is red

- **WHEN** the manifest is absent, unparsable, or contains zero D-table
  entries, and the gate runs
- **THEN** the gate exits non-zero instead of passing vacuously

### Requirement: The seam-assertion gate is a canon gate

The gate SHALL ship with a paired self-test
(`node <script>.mjs && node --test <script>.test.mjs`) proving its red paths on
fixtures without touching the real tree.

#### Scenario: The paired self-test proves the red paths

- **WHEN** the self-test runs under `node --test`
- **THEN** it demonstrates non-zero outcomes for a missing-seam fixture, a
  duplicate-implementation fixture, and an empty-seam-set fixture
