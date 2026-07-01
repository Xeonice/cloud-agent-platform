## ADDED Requirements

### Requirement: Provider-neutral terminal session logic lives under the sandbox center

Shared browser-facing live-terminal behavior SHALL live under the sandbox center rather than API-local provider implementations. This includes selected-run terminal session creation, provider terminal transport selection, snapshot and tail replay, ACK/backpressure integration, reconnect frame building, resize propagation, and stale transport replacement. Provider packages SHALL expose provider-specific terminal session/transport factories behind the sandbox terminal harness.

#### Scenario: Provider packages do not own reconnect replay
- **WHEN** AIO or BoxLite provider package code is inspected
- **THEN** it exposes terminal descriptors or transport primitives for its backend
- **AND** it does not implement browser reconnect replay, `session.log` tail selection, snapshot serialization policy, or web reveal timing

#### Scenario: Sandbox terminal session consumes provider descriptors
- **WHEN** a browser attaches to a provider-backed interactive task
- **THEN** the sandbox terminal session layer resolves the selected run's terminal descriptor
- **AND** opens the matching provider transport behind CAP's browser-facing terminal protocol

#### Scenario: API gateway does not instantiate provider terminal clients
- **WHEN** `TerminalGateway.openSession()` is inspected
- **THEN** it delegates terminal creation to the sandbox terminal harness
- **AND** it does not instantiate AIO or BoxLite terminal clients, register provider terminal protocol strings, or parse provider-specific terminal descriptor metadata

#### Scenario: Provider-specific reconnect mechanics stay with the provider
- **WHEN** AIO or BoxLite needs provider-specific initial ready handling, attach/reconnect, command probing, resize transport, or exit status resolution
- **THEN** the behavior is implemented by the owning provider package or provider terminal harness
- **AND** API terminal code only receives normalized terminal output and exit status callbacks

### Requirement: Web provider terminal fixtures verify initial render and reconnect

The web terminal SHALL have fixture-driven Playwright coverage for provider-backed terminal rendering. The fixture path SHALL not start CAP API or live provider resources.

#### Scenario: Fixture replay hides until final tail replay
- **WHEN** the web provider terminal fixture emits a snapshot followed by tail replay frames and a final tail replay marker
- **THEN** the terminal remains hidden or guarded during replay
- **AND** it reveals after the final marker with the terminal scrolled to the expected position

#### Scenario: Fixture reconnect does not duplicate or drop output
- **WHEN** the fixture simulates a reconnect with prior output, snapshot, tail replay, and later live frames
- **THEN** the rendered terminal contains the expected output exactly once
- **AND** later live frames continue to append after replay completes

#### Scenario: AIO and BoxLite descriptors render through the same web path
- **WHEN** fixture selected-runs use AIO and BoxLite terminal descriptors
- **THEN** the frontend renders through the same `SessionTerminal` path
- **AND** it does not branch on provider family for browser protocol behavior
