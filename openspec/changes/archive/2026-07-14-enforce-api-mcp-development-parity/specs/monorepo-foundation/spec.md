## ADDED Requirements

### Requirement: Public contract edits validate downstream consumers

The edit-time TypeScript hook SHALL classify changes to public contracts,
capability registry entries, Public V1 bindings, MCP adapters, OpenAPI projection,
and Playground projection. For a public contract or registry edit it SHALL
typecheck `@cap/contracts` and every directly affected API/Web consumer and SHALL
run `pnpm test:public-surface`; checking only the owning package SHALL NOT count
as success. The classifier SHALL be shared by edit and staged-file gates so their
trigger sets cannot silently diverge.

#### Scenario: A contracts edit omits an MCP adapter

- **WHEN** a developer adds a mapped operation in `@cap/contracts` but has not
  added its exhaustive API adapter
- **THEN** the edit-time downstream typecheck exits non-zero and surfaces the
  missing operation id

#### Scenario: An unrelated edit avoids the focused gate

- **WHEN** an edited file is outside every public-surface and OpenSpec metadata
  trigger path
- **THEN** the classifier does not run the public-surface suite for that edit
- **AND** the repository's existing lint/typecheck behavior still applies

### Requirement: Contracts tests participate in normal verification

`@cap/contracts` SHALL expose a package test command, and its schema, registry,
and type fixtures SHALL run under the focused public-surface command and the
normal CI test graph. A test file present in the contracts package but absent
from normal package/CI scripts SHALL NOT be considered enforced.

#### Scenario: A contracts fixture fails

- **WHEN** a contracts registry/schema test fails
- **THEN** the package test, `pnpm test:public-surface`, and the corresponding CI
  gate all exit non-zero

### Requirement: Local hooks and CI reuse stable public-surface commands

The repository SHALL expose `pnpm test:public-surface` for the infrastructure-free
focused suite and `pnpm verify:public-surface` for the full push/CI gate. Relevant
staged files SHALL run the focused command once through pre-commit; pre-push SHALL
run the full command without relying on an incomplete single-commit diff; CI SHALL
invoke the same full root command in a stable merge-gating job. These layers MUST
reuse root scripts rather than maintaining separate command lists.

#### Scenario: Relevant staged files fail pre-commit once

- **WHEN** one or more staged public-surface files contain a parity defect
- **THEN** pre-commit invokes the focused root command once and blocks the commit
- **AND** it does not launch duplicate concurrent parity runs for overlapping
  globs

#### Scenario: A bypassed local hook is caught remotely

- **WHEN** a developer bypasses edit or commit hooks and pushes a parity defect
- **THEN** pre-push or the stable CI merge gate runs
  `pnpm verify:public-surface`, exits non-zero, and prevents the defect from being
  treated as mergeable

#### Scenario: Full gate is service-independent

- **WHEN** `pnpm verify:public-surface` runs on a fresh checkout with its declared
  build/code-generation prerequisites
- **THEN** it verifies contracts, API parity, OpenAPI, and Playground without a
  production database, external credential, or listening-port probe
