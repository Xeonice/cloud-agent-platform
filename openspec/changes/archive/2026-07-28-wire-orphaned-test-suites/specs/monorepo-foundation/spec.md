## MODIFIED Requirements

### Requirement: Contracts tests participate in normal verification

Every workspace package that owns tests SHALL expose a package test command, and
those tests SHALL run under the repository-wide test task and the normal CI test
graph. `@cap/contracts` schema, registry, and type fixtures SHALL additionally run
under the focused public-surface command. A test file present in any workspace
package but absent from the normal package/CI test graph SHALL NOT be considered
enforced, and the repository SHALL detect that condition mechanically rather than
relying on review to notice it.

#### Scenario: A contracts fixture fails

- **WHEN** a contracts registry/schema test fails
- **THEN** the package test, `pnpm test:public-surface`, and the corresponding CI
  gate all exit non-zero

#### Scenario: Any package's failing test fails the graph

- **WHEN** a test fails in any workspace package that declares a test command
- **THEN** the repository-wide test task and the CI job invoking it exit non-zero

#### Scenario: An unenforced test file is detected, not tolerated

- **WHEN** a test file exists in a workspace package but no configured runner
  would execute it
- **THEN** the repository's discovery check exits non-zero and names that file
