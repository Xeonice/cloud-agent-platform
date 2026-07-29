## ADDED Requirements

### Requirement: Every workspace package SHALL share one npm scope the project controls

All packages in the workspace SHALL be named under a single npm scope, and that
scope SHALL be one the project owns on the public registry. Publishing any package
SHALL therefore require no rename.

A package that is never published SHALL NOT be exempt. The registry does not
validate a name it is never asked to publish, so an unowned scope can persist
indefinitely on unpublished packages and is discovered only at the moment
publishing becomes necessary — which is the moment it is most expensive to fix.

Ownership SHALL be established by an authenticated, member-scoped query rather
than by absence of evidence: a 404 on a package name, or an empty public listing
for a scope, proves only that nothing has been published there.

#### Scenario: A package can be published without being renamed

- **WHEN** any workspace package is prepared for publication to the public
  registry
- **THEN** its existing name SHALL be publishable as-is, because its scope is
  already owned by the project

#### Scenario: Unpublished packages carry the same scope as published ones

- **WHEN** the workspace package names are inspected
- **THEN** every package SHALL share one scope, so that no reader or tool has to
  know which names are registry names and which are local-only

#### Scenario: Scope ownership is proven, not assumed

- **WHEN** scope ownership is asserted
- **THEN** the evidence SHALL be an authenticated query that distinguishes an
  owned scope from an unowned one, verified against a control that is known not to
  be owned
