# Research Brief

## Problem Evidence

- Local tmux verification reproduced the UTF-8 rendering failure: under `LC_ALL=C`, plain `tmux attach` rendered `中文OK` as `____OK`; `tmux -u attach` preserved the Chinese text.
- Local tmux geometry verification showed detached sessions start at `80x24` by default. `tmux resize-window -x <cols> -y <rows>` immediately updated the running pane's `stty size`, `COLUMNS`, and `LINES`.
- Local Node verification showed per-frame `Buffer.toString('utf8')` corrupts multibyte characters when a UTF-8 sequence is split across chunks (`A中文B` became `A���文B`). `StringDecoder('utf8')` preserved the text.
- A targeted BoxLite transport harness reproduced the same corruption through the real `BoxLiteTerminalTransport` path when a Chinese payload was split across two stdout WebSocket frames.
- Headless xterm accepted both string and byte writes for `中文OK`, so the rendering emulator is not the primary source of this specific corruption.

## Existing Specs

- `realtime-terminal` already owns browser-facing terminal parity, geometry sync, provider-neutral gateway behavior, recording, and live xterm behavior.
- `aio-sandbox-execution` owns the shared `AioPtyClient` detached tmux session launch/attach model and terminal frame translation.
- `boxlite-sandbox-provider` owns BoxLite terminal transport conformance and provider capability gating.

## Code Pointers

- `apps/api/src/terminal/codex-launch.ts` builds `tmux new-session -d ...` without `-u` or initial geometry.
- `apps/api/src/terminal/aio-pty-client.ts` attaches with `tmux attach -t ...` and forwards resize only to the provider transport.
- `apps/api/src/terminal/boxlite-terminal-transport.ts` decodes each stdout/stderr WebSocket frame with `payload.toString('utf8')`.
- `apps/web/src/components/session/session-terminal.tsx` sends browser geometry on terminal WebSocket open.
- `apps/api/src/terminal/terminal.gateway.ts` forwards browser resize frames to `session.pty.resize()` and the headless snapshot terminal.

## Conclusion

The fix should stay inside the terminal seams:

- make tmux launch/attach UTF-8 aware;
- stream-decode provider terminal output before it reaches the shared raw-output pipeline;
- resize the authoritative detached tmux window when browser geometry changes;
- keep the browser protocol and public provider API unchanged.
