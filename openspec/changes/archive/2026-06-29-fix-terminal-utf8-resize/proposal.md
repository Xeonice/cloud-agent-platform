## Why

Live task terminals can render Chinese output as underscores or replacement characters and can show a narrow 80x24 TUI inside a much larger browser terminal. This breaks the operator's ability to inspect and drive running tasks, especially on the macOS/BoxLite deployment path where the issue has been observed in production.

## What Changes

- Make the shared detached tmux launch/attach path UTF-8 aware so tmux renders multibyte output correctly even when the sandbox locale is not UTF-8.
- Preserve UTF-8 sequences across BoxLite stdout/stderr WebSocket frame boundaries before emitting output into CAP's shared terminal pipeline.
- Resize the authoritative detached tmux window whenever browser terminal geometry reaches the API, not only the outer provider PTY, so full-screen TUIs redraw at the browser's cols/rows.
- Add focused regression coverage for tmux command generation, BoxLite split UTF-8 output, and terminal resize propagation.
- Keep the browser terminal protocol, public task APIs, provider selection model, and release/deploy path unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `realtime-terminal`: live terminal output and geometry parity must preserve UTF-8 text and size the authoritative detached session to the browser terminal.
- `aio-sandbox-execution`: the shared AioPtyClient/tmux execution path must launch/attach UTF-8-aware tmux clients and propagate browser resize to the detached tmux session.
- `boxlite-sandbox-provider`: BoxLite terminal transport must stream-decode UTF-8 output across provider WebSocket frame boundaries before handing bytes to CAP's gateway.

## Impact

- API terminal code: `apps/api/src/terminal/codex-launch.ts`, `apps/api/src/terminal/aio-pty-client.ts`, `apps/api/src/terminal/boxlite-terminal-transport.ts`, terminal transport tests.
- Runtime launch tests: codex/agent-runtime golden expectations for the detached tmux wrapper and attach command.
- BoxLite transport conformance tests for split multibyte stdout/stderr frames.
- No database migration, external API change, browser protocol change, or new runtime dependency is expected.
