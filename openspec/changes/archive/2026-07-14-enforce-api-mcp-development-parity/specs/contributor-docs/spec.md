## ADDED Requirements

### Requirement: Guide documents the public-surface parity workflow

`CONTRIBUTING.md` SHALL explain that every feature change must explicitly decide
whether it affects Public V1, MCP, OpenAPI, API Playground, or internal-only
behavior. It SHALL document `surface-impact.json`, explicit protocol exclusions
and projections, the task metadata fields, and the stable
`pnpm test:public-surface` / `pnpm verify:public-surface` commands. The guide SHALL
state that a feature need not be publicly exposed, but an omitted public-surface
decision is invalid.

#### Scenario: Contributor adds a public capability

- **WHEN** a contributor follows the guide for a feature that changes a public
  programmatic capability
- **THEN** they can identify where to declare both transport impacts, where to
  record a protocol exclusion, and which local command verifies the change

#### Scenario: Contributor adds an internal-only feature

- **WHEN** a contributor follows the guide for an internal-only feature
- **THEN** they can record concrete not-applicable reasons without inventing an
  unnecessary REST endpoint or MCP tool

#### Scenario: Task verification convention is documented

- **WHEN** a contributor authors `tasks.md`
- **THEN** the guide shows requirement, surface, and allowlisted verifier metadata
- **AND** it states that a checkbox is completed only after that verifier passes
