## ADDED Requirements

### Requirement: Readoption routes through the owning provider

The system SHALL re-adopt running tasks through the provider that owns their sandbox. When durable provider owner metadata exists, readoption SHALL use that provider first; when it does not exist, the system MAY probe compatible providers but SHALL only adopt a task after a provider proves the sandbox and detached session are alive.

#### Scenario: Stored owner drives readoption
- **WHEN** the API restarts and a running task has provider owner metadata for BoxLite
- **THEN** readoption asks the BoxLite provider to reattach that task's sandbox and detached session
- **AND** it does not attempt to reattach the task through AIO first

#### Scenario: Provider must prove session liveness
- **WHEN** a provider claims a running task during readoption
- **THEN** it verifies the provider sandbox is alive and the detached task session is alive before the task is kept running

### Requirement: Detached session semantics are provider-neutral

Interactive runtimes SHALL continue to run inside a detached named session that outlives the API-to-provider terminal transport. The initial implementation MAY use tmux for both AIO and BoxLite, but callers SHALL depend on a detached-session driver rather than AIO-specific shell commands.

#### Scenario: Transport close does not stop the agent
- **WHEN** the API-to-BoxLite terminal transport closes while the detached task session is alive
- **THEN** the agent process keeps running inside the provider sandbox

#### Scenario: Reconnect attaches to the existing session
- **WHEN** an operator reconnects to a BoxLite-backed task whose detached session is alive
- **THEN** CAP attaches to that existing session rather than launching a new agent process

### Requirement: Concurrent attach remains single-writer for every provider

Multiple operators MAY view the same provider-backed task session, but only the CAP write-lease holder SHALL inject input. Provider-native terminal sharing or attach behavior SHALL NOT bypass CAP's write-lock.

#### Scenario: BoxLite shared session is read-only for non-holders
- **WHEN** two operators are attached to a BoxLite-backed task and only one holds the write lease
- **THEN** both operators see output
- **AND** only the lease holder's input is forwarded to the provider transport
