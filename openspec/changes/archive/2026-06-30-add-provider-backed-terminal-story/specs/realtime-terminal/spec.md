## ADDED Requirements

### Requirement: Provider-backed terminal story uses CAP gateway

The realtime terminal SHALL provide an opt-in local provider-backed story that validates the browser-to-CAP-terminal-gateway-to-provider path. The browser SHALL connect only to CAP's terminal WebSocket protocol and SHALL NOT receive or use AIO, BoxLite, or other provider-native terminal URLs.

#### Scenario: Provider-backed story is disabled by default

- **WHEN** the provider-backed terminal story creation endpoint or script is invoked without the explicit local enable flag
- **THEN** the system refuses to create a story session with a clear not-enabled result
- **AND** no sandbox provider resource is created

#### Scenario: Browser connects only to CAP terminal gateway

- **WHEN** the provider-backed story opens a live terminal
- **THEN** the browser connects to CAP's `/terminal` WebSocket using the same browser frame protocol as task terminals
- **AND** the browser receives no provider-native terminal URL or provider credential

#### Scenario: Story creates a deterministic provider-backed PTY fixture

- **WHEN** the provider-backed story setup runs with a valid selected provider
- **THEN** the API creates a temporary terminal fixture session backed by that provider
- **AND** the fixture emits deterministic UTF-8 output, long scrollback output, resize-sensitive geometry markers, and an input echo prompt

#### Scenario: Story verifies provider-backed terminal behavior

- **WHEN** the provider-backed story verification runs against the temporary fixture session
- **THEN** it verifies live output reaches xterm through CAP's gateway
- **AND** operator input reaches the provider-backed PTY
- **AND** browser resize changes are observed by the fixture
- **AND** UTF-8 text renders without replacement characters
- **AND** long output remains scrollable

#### Scenario: Story verifies reconnect through gateway replay

- **WHEN** the provider-backed story disconnects and reconnects after fixture output has been produced
- **THEN** CAP reconnect replay restores prior output through gateway-owned replay
- **AND** the story continues receiving new provider output after reconnect

#### Scenario: Story session is cleaned up

- **WHEN** provider-backed story verification completes or fails
- **THEN** the temporary terminal story session is torn down
- **AND** the selected sandbox provider is asked to release the backing sandbox resource

### Requirement: Provider-backed story honors explicit provider selection

The provider-backed terminal story SHALL honor the operator-selected provider or topology for local verification. When a provider is explicitly requested, missing readiness or capability SHALL fail the story setup rather than silently selecting another provider.

#### Scenario: Explicit provider selection fails closed

- **WHEN** the story is configured to use a specific provider and that provider is not ready
- **THEN** story setup fails with the selected provider's readiness error
- **AND** the system does not fall back to another provider

#### Scenario: Default provider selection is reported

- **WHEN** no provider is explicitly requested and the local default provider is used
- **THEN** the story reports the provider id backing the temporary terminal session
- **AND** the verification output identifies which provider path was exercised
