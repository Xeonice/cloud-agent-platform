## Why

Pure xterm stories can catch browser rendering defects, but they cannot prove the full CAP terminal chain works against a real sandbox provider. We need an opt-in local story that connects through CAP's TerminalGateway to the selected provider so BoxLite/AIO terminal output, input, resize, UTF-8, and scrollback can be validated before deployment.

## What Changes

- Add a local-only provider-backed terminal story/lab that uses the CAP browser terminal protocol and never connects directly to provider-native terminal URLs.
- Add an API-side dev/test path, gated by explicit env, that creates a temporary provider-backed PTY fixture session using the configured sandbox provider.
- Validate provider readiness and fail closed when required BoxLite or AIO configuration is missing.
- Exercise deterministic live terminal behavior over the real provider path: output, input, resize, UTF-8, long scrollback, reconnect/tail replay, and teardown.
- Add local verification scripts/tests that run only when explicitly enabled and skip honestly otherwise.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `realtime-terminal`: add a required opt-in provider-backed terminal story that validates the browser-to-TerminalGateway-to-provider path without bypassing CAP's gateway.
- `boxlite-sandbox-provider`: add local story/readiness requirements for BoxLite-backed terminal verification, including required env, pty terminal mode, and terminal capability checks.

## Impact

- Frontend:
  - provider-backed terminal story/lab UI
  - reuse of `TerminalSocket` / session terminal rendering where practical
- API:
  - dev/test-only provider-backed terminal fixture session creation and teardown
  - provider readiness reporting for the story path
- Sandbox providers:
  - AIO default path and BoxLite configured path exercised through the same terminal gateway contract
- Verification:
  - opt-in local Playwright/e2e checks requiring a running API and usable sandbox provider
- No public production API, database migration, browser protocol change, or provider-native URL exposure is expected.
