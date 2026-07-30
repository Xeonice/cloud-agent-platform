## ADDED Requirements

### Requirement: Each major subtree SHALL carry instructions that bound its own scope

A subtree that an agent can reasonably be asked to work in alone SHALL carry
directory-scoped instructions at its root. Those instructions SHALL state what the
subtree is, what it may depend on, what it must not reach into, and how a change
to it is verified.

The repository SHALL NOT carry a root-level instruction file describing every
package. Instructions that reach every agent regardless of the task restore the
undifferentiated context this requirement exists to remove.

Instructions SHALL route rather than explain: where an agent is likely to search
locally for something that lives in another subtree, the file SHALL name where it
actually lives. Architecture belongs in specs, which already carry it.

#### Scenario: An agent working in one subtree learns its boundary

- **WHEN** an agent begins work inside a subtree that carries these instructions
- **THEN** it SHALL be told what that subtree owns and what belongs elsewhere,
  without having to read the other subtrees to find out

#### Scenario: A cross-subtree concern is routed rather than duplicated

- **WHEN** a subtree's instructions mention a concern that is declared or
  implemented outside it
- **THEN** they SHALL name the location that owns it, so a local search that would
  return misleading hits is pre-empted

#### Scenario: No instruction file describes the whole repository

- **WHEN** the repository root is inspected
- **THEN** it SHALL NOT contain an agent instruction file, so that what an agent
  is told depends on where it is working
