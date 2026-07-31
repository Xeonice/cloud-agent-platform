## ADDED Requirements

### Requirement: The product layout SHALL be documented alongside the tooling layout

A guide SHALL document the product side of the repository — which packages exist,
which are deployment units, which are optional, and what an operator actually has
to run. It SHALL be a sibling of the existing tooling-layout guide rather than an
edit to it, and the two SHALL cross-link.

Facts that determine what an operator deploys SHALL be stated in the guide rather
than left discoverable only by reading configuration. In particular, where a
deployment unit is optional, the guide SHALL say so and say how it is enabled.

#### Scenario: An operator can determine the minimum deployable unit

- **WHEN** someone intending to self-host reads the product layout guide
- **THEN** they SHALL be able to tell which services are required and which are
  optional, without reading deployment configuration comments to find out

#### Scenario: The two guides are distinguishable and linked

- **WHEN** either guide is opened
- **THEN** it SHALL state which question it answers and link to its sibling, so a
  reader who opened the wrong one is routed rather than misled
