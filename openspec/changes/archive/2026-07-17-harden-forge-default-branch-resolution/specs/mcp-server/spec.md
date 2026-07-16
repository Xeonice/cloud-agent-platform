## ADDED Requirements

### Requirement: MCP preserves canonical forge branch and platform dependency truth

The matching MCP task and repository tools SHALL project the same canonical
Task and Repo schemas as Public V1. `create_task`, `list_tasks`, `get_task`, and
`stop_task` SHALL preserve the additive
`provisioning_platform_dependency_unavailable` failure and its
`repair_deployment` action without mapping it to a generic MCP transport,
network, or TLS error. `list_repos` and `get_repo` SHALL return the persisted
verified nullable `defaultBranch` without substituting `main` or `master`.
`list_schedules`, `create_schedule`, `get_schedule`, `update_schedule`,
`pause_schedule`, `resume_schedule`, `dispatch_schedule`, and
`list_schedule_runs` SHALL preserve the same variant wherever their canonical
schedule or run response nests `taskFailure`.
`create_task` SHALL use the same shared branch preparation as Console/Public V1.
MCP SHALL NOT add repository import or refresh tools, because those remain
Console/Internal administration writes.

#### Scenario: MCP task uses a GitHub trunk default

- **WHEN** an MCP owner creates a task without `branch` for a GitHub Repo whose verified default is `trunk`
- **THEN** the shared task path snapshots `trunk` and MCP task reads expose that resolved branch
- **AND** no MCP adapter invents `main` or `master`

#### Scenario: MCP preserves the platform dependency failure

- **WHEN** a canonical task contains `provisioning_platform_dependency_unavailable`
- **THEN** matching MCP task tools return the same structured code and `repair_deployment` action
- **AND** compatibility text contains only safe canonical content

#### Scenario: MCP schedule tools preserve nested task failure parity

- **WHEN** an MCP schedule response contains a latest run or run-ledger item whose task has the platform dependency failure
- **THEN** the matching schedule tool returns the canonical code and `repair_deployment`
- **AND** the schedule adapter does not collapse it into a transport, network, or TLS error

#### Scenario: MCP repository inventory remains read-only

- **WHEN** MCP operation/tool parity is generated for repository behavior
- **THEN** `list_repos` and `get_repo` expose refreshed verified branches
- **AND** no import or refresh tool is registered
