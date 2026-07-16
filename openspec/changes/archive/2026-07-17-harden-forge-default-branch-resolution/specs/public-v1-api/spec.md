## MODIFIED Requirements

### Requirement: Public task and repository reads project provisioning truth safely

The canonical public registry operations SHALL project the same additive,
secret-free task provisioning summary and structured failure variants for
`tasks.create`, `tasks.list`, `tasks.get`, and `tasks.stop` that are used by the
runtime contracts, including
`provisioning_platform_dependency_unavailable` with
`repair_deployment`. The same canonical Task failure is nested by the existing
`schedules.list`, `schedules.create`, `schedules.get`, `schedules.update`,
`schedules.pause`, `schedules.resume`, `schedules.dispatch`, and
`schedules.runs` outputs, so those operations SHALL project the new variant
wherever a latest run or run-ledger item contains `taskFailure`. `repos.list`
and `repos.get` SHALL return the latest
persisted verified default branch through their existing nullable field,
including arbitrary valid values such as GitHub `trunk`, GitLab `develop`, and
Gitee `master`. Generated OpenAPI SHALL describe the exact optional/nullable
semantics and stable failure variants, and the API Playground SHALL derive the
same operations and preserve success and non-success bodies. No provider
secret, lease identity, authenticated Git command, temporary config path, or raw
diagnostic SHALL enter these projections. No public repository import or
refresh write SHALL be added.
Current readers SHALL continue to accept payloads produced before this variant
exists. Because `TaskFailure` is a closed discriminator, the API and Web SHALL
ship as a matched version and compatibility documentation SHALL NOT claim that
a strict N-1 client can parse the new discriminator.

#### Scenario: Registry-derived task response includes safe progress

- **WHEN** a Public V1 client creates or reads a task during workspace transfer
- **THEN** the response validates against the canonical Task schema and includes the safe transfer stage
- **AND** the matching OpenAPI operation and MCP structured output use that same schema

#### Scenario: Public task failure distinguishes a platform dependency

- **WHEN** a task terminalizes because the control-plane Git executable cannot start
- **THEN** Public V1 task create/list/get/stop projections preserve `provisioning_platform_dependency_unavailable` and `repair_deployment`
- **AND** OpenAPI, API Playground, and MCP use the same canonical variant without raw process detail

#### Scenario: Schedule responses preserve their nested task failure

- **WHEN** a schedule latest run or run-ledger item references a task settled with `provisioning_platform_dependency_unavailable`
- **THEN** every schedule operation returning that nested shape preserves the code and `repair_deployment`
- **AND** its Public V1, OpenAPI, API Playground, and MCP projections use the same canonical TaskFailure schema

#### Scenario: Repo read returns an arbitrary verified default branch

- **WHEN** a Public V1 client reads a refreshed GitHub repository whose verified default is `trunk`
- **THEN** `repos.list` and `repos.get` return `defaultBranch = trunk`
- **AND** no public repo-import or refresh write operation is added

#### Scenario: Public projections contain no provider secrets

- **WHEN** task/repo responses, OpenAPI examples, Playground rendering, and MCP structured content are inspected
- **THEN** they contain no credential, temporary secret path, lease owner, provider endpoint, authenticated command, or raw diagnostic

#### Scenario: Compatibility fixture states the achievable direction

- **WHEN** wire-compatibility fixtures exercise legacy Task and schedule payloads with the current schemas
- **THEN** current Public V1, MCP, OpenAPI, and Playground readers accept those previous payloads
- **AND** the fixture records that a strict N-1 closed-union reader requires an upgrade before consuming the new failure value
