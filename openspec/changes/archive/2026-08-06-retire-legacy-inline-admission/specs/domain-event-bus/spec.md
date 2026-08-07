## ADDED Requirements

### Requirement: Publish-point counts that name a retired path are re-pinned by measurement

Requirements that pin the number of publish points for an event SHALL be re-pinned when a retirement
removes one of those points, and the new number SHALL come from counting the live sites rather than
from subtracting one from the old number. Subtraction is how a count drifts: it assumes the old
number was right and that exactly one site left, and this repository has already shipped a stale
pinned count that no live measurement supported.

Where such a requirement states its count IN ITS HEADING, the re-pinning SHALL be expressed as a
removal of the old requirement and an addition of the new one, not as a modification. A modification
is matched to the live specification by heading text, so a heading whose number changed does not
match and the modification would silently fail to apply.

#### Scenario: Each re-pinned count is measured on the post-change tree

- **WHEN** each publish-point requirement's count is compared with a live count of the publish sites
  for that event
- **THEN** the two agree, and the change's records name the command that produced the live count

#### Scenario: A count in a heading is re-pinned by removal and addition

- **WHEN** the change's delta for a requirement whose heading carries a count is read
- **THEN** the old requirement appears under removal and the new one under addition, and no
  modification block names a heading that no longer exists in the live specification
