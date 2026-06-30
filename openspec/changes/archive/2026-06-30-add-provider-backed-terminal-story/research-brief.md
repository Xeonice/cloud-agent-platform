## Research Brief

### Codebase Findings

- Browser terminal traffic is centralized in `apps/web/src/lib/ws-client.ts`. The client connects to CAP's `/terminal` WebSocket, sends reconnect/resize/keystroke/ack frames, and never talks directly to sandbox provider endpoints.
- The live terminal component is `apps/web/src/components/session/session-terminal.tsx`. It already owns reconnect replay, ACK after xterm flush, resize on socket open, input takeover, and terminal viewport sync.
- API-side provider transport is abstracted below the terminal gateway. `apps/api/src/terminal/boxlite-terminal-transport.ts` starts a BoxLite TTY exec, attaches over WebSocket, sends resize/input, and stream-decodes stdout/stderr with stateful UTF-8 decoders.
- `packages/sandbox-provider-boxlite/src/boxlite-config.ts` requires `BOXLITE_ENDPOINT`, `BOXLITE_API_TOKEN`, and `BOXLITE_IMAGE`/image map. Interactive terminal capability requires `BOXLITE_TERMINAL_MODE=pty` and `terminal.websocket,terminal.interactive` capabilities.
- `scripts/boxlite-up.sh` already validates BoxLite env and readiness for local startup. It writes pty terminal defaults and fails closed when required BoxLite env is absent.
- Existing web visual tests intentionally avoid live backend connections. The provider-backed story needs a separate, opt-in verification path that can create/attach a real provider-backed terminal session.

### Prior OpenSpec Context

- `boxlite-sandbox-provider` requires BoxLite terminal support to remain behind CAP `TerminalGateway`; browsers must never receive provider-native terminal URLs.
- `realtime-terminal` requires provider-neutral browser protocol, gateway-owned recording/replay, geometry sync, UTF-8 preservation, scrollback, and provider transport abstraction.
- `fix-terminal-utf8-resize` and `fix-live-terminal-refresh-replay` fixed real terminal defects but left no local story that exercises the full browser-to-provider chain.

### External References

- BoxLite README documents `boxlite serve` as a REST service and lists interactive PTY with live resize as a supported feature: https://github.com/boxlite-ai/boxlite
- BoxLite CLI reference documents `BOXLITE_REST_URL`, `BOXLITE_API_KEY`, and remote REST targeting through `--url`: https://github.com/boxlite-ai/boxlite/blob/main/docs/reference/cli/README.md

### Recommended Direction

Add a dev-only provider-backed terminal lab that provisions or attaches a temporary terminal session through the same CAP terminal gateway protocol used by tasks. The story should accept a selected provider/topology from local env, validate provider readiness before opening, run a deterministic shell/PTY fixture through the provider, and tear it down after verification. It must fail closed unless explicitly enabled and must not expose BoxLite/AIO URLs to the browser.
