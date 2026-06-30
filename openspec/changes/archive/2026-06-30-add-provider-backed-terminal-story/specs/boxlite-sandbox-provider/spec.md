## ADDED Requirements

### Requirement: BoxLite provider-backed terminal story validates readiness

When the provider-backed terminal story is configured to use BoxLite, the system SHALL validate BoxLite endpoint configuration, image configuration, terminal mode, and terminal capabilities before creating the story session. Missing or invalid BoxLite configuration SHALL fail the story setup clearly and SHALL NOT fall back to AIO.

#### Scenario: Missing BoxLite configuration blocks story setup

- **WHEN** the provider-backed terminal story is configured for BoxLite and `BOXLITE_ENDPOINT`, `BOXLITE_API_TOKEN`, or `BOXLITE_IMAGE`/image map is missing
- **THEN** story setup fails before creating a sandbox
- **AND** the failure names the missing BoxLite configuration

#### Scenario: BoxLite terminal capability is required

- **WHEN** the provider-backed terminal story is configured for BoxLite without `BOXLITE_TERMINAL_MODE=pty` or without `terminal.websocket` and `terminal.interactive` capabilities
- **THEN** story setup fails before opening a terminal session
- **AND** the failure explains that interactive BoxLite terminal capability is required

#### Scenario: BoxLite endpoint readiness is checked

- **WHEN** the provider-backed terminal story is configured for BoxLite
- **THEN** the setup verifies the configured BoxLite endpoint is reachable using the configured API token before creating the story session
- **AND** an unreachable endpoint produces a clear readiness failure

#### Scenario: BoxLite story session stays behind CAP gateway

- **WHEN** the BoxLite-backed terminal story opens in the browser
- **THEN** the browser connects only to CAP's terminal gateway
- **AND** the BoxLite endpoint, API token, sandbox id, and native terminal URL remain server-side

#### Scenario: BoxLite terminal story verifies resize and UTF-8

- **WHEN** the BoxLite-backed terminal story verification runs
- **THEN** it proves output, input, resize, and UTF-8 text pass through the BoxLite terminal transport behind CAP's gateway
- **AND** the verification reports BoxLite as the provider path exercised
