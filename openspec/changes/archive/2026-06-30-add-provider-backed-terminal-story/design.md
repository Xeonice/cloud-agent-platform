## Context

The pure xterm story verifies browser rendering, but it cannot prove the provider-backed terminal path. The production path is:

```
browser xterm -> CAP /terminal WebSocket -> TerminalGateway -> terminal pty seam -> provider transport -> sandbox PTY
```

BoxLite is especially sensitive here because the provider terminal endpoint is internal to the API process. The browser must not learn or connect to BoxLite-native terminal URLs. Local validation therefore needs a real provider-backed session while preserving CAP's gateway boundary.

## Goals / Non-Goals

**Goals:**

- Provide an opt-in local story that opens a real provider-backed terminal through CAP's browser WebSocket protocol.
- Support the default AIO local path and the configured BoxLite path.
- Validate output, input, resize, UTF-8, scrollback, reconnect replay, and teardown over the actual provider transport.
- Fail closed when the selected provider is not configured or lacks terminal capability.
- Keep provider secrets and provider-native URLs server-side only.

**Non-Goals:**

- Do not expose provider-native terminal URLs to browsers.
- Do not add a production feature or public customer API.
- Do not use nondeterministic agent behavior as the validation oracle.
- Do not change the browser terminal frame protocol.
- Do not silently fall back from an explicitly requested provider to another provider.

## Decisions

### D1 - Reuse CAP TerminalGateway as the only browser boundary

The provider-backed story shall use the same browser `TerminalSocket` protocol as task pages. The API will own any provider session creation and will register or expose a temporary story session only through CAP's terminal gateway.

Alternative considered: connect the browser story directly to BoxLite's terminal WebSocket. That would bypass the exact CAP behavior we need to validate: ACKs, reconnect replay, write lock, gateway recording, and provider URL secrecy.

### D2 - Add an explicit dev/test-only story session path

Add an API path or service that is inert unless an explicit environment flag is enabled, for example `CAP_PROVIDER_TERMINAL_STORY=1`. When disabled, story session creation fails with a clear not-enabled response.

The story path should create a temporary provider-backed PTY fixture session, return only a CAP story/session id, and clean it up after verification. It should not require a production task workflow or a nondeterministic agent prompt.

Alternative considered: create a normal Codex task and point the story at that task id. That verifies production flow, but Codex output is nondeterministic and does not give reliable assertions for UTF-8, scrollback, resize, and input.

### D3 - Use a deterministic shell/PTY fixture behind the same pty seam

The provider-backed session should run a deterministic shell script or tmux-backed fixture that emits known UTF-8 text, many lines of output, resize-sensitive geometry markers, and a prompt that echoes input. The fixture should still run inside the selected sandbox provider and use the same terminal transport abstraction that task terminals use.

This keeps the oracle stable while exercising the real provider WebSocket/PTY path.

### D4 - Validate provider readiness before opening the story

For AIO, the story setup should confirm Docker/socket/provider readiness through existing local readiness assumptions. For BoxLite, the setup should require:

- `BOXLITE_ENDPOINT`
- `BOXLITE_API_TOKEN`
- `BOXLITE_IMAGE` or a usable runtime image map
- `BOXLITE_TERMINAL_MODE=pty`
- `terminal.websocket` and `terminal.interactive` capabilities

When BoxLite is explicitly selected, missing or invalid config must fail the story setup rather than falling back to AIO.

### D5 - Keep verification opt-in and self-cleaning

The Playwright/e2e command should run only when the operator explicitly opts in, because it consumes real sandbox resources and may require BoxLite or Docker. The command should create the story session, run assertions, and tear down provider resources even on failure.

## Risks / Trade-offs

- **Risk:** Dev-only API paths can accidentally become production surface.
  **Mitigation:** Gate creation behind an explicit env flag, keep route names internal, and avoid documenting them as public APIs.
- **Risk:** Provider resources leak after a failed test.
  **Mitigation:** Use short TTLs, explicit teardown, and best-effort cleanup in test `afterEach`/`finally` blocks.
- **Risk:** Provider readiness differs between AIO and BoxLite.
  **Mitigation:** Make selected-provider readiness explicit and fail closed; do not hide BoxLite failures by selecting another provider.
- **Risk:** Reusing the terminal gateway for non-task story sessions may create ownership ambiguity.
  **Mitigation:** model story sessions as ephemeral internal terminal sessions with clear ids, ownership, TTL, and cleanup, rather than pretending they are normal customer tasks.
- **Risk:** Real provider validation is slower and environment-dependent.
  **Mitigation:** keep it out of default CI and provide honest skip/failure messages when prerequisites are absent.

## Migration Plan

1. Build the dev/test-only API story session service behind an explicit enable flag.
2. Add provider readiness checks and selected-provider fail-closed behavior.
3. Add the provider-backed story UI that connects only to CAP's `/terminal` endpoint using a story session id.
4. Add opt-in Playwright/e2e verification with setup and teardown.
5. Validate locally with AIO, then with a real configured BoxLite endpoint.
6. Rollback by disabling the env flag or removing the story session service and story UI; no persisted data migration is involved.

## Open Questions

- Whether the story session should use the existing task id namespace with a reserved prefix or a separate internal story-session id namespace. The implementation should choose the option with less coupling to production task state.
