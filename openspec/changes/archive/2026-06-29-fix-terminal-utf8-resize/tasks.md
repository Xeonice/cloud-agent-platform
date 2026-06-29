## 1. Track: tmux-utf8-resize (depends: none)

- [x] 1.1 Update detached tmux launch helpers so interactive and headless session creation invoke tmux in UTF-8 mode without changing prompt-file delivery semantics.
- [x] 1.2 Update the shared attach path so launch, reattach, and stale-bridge replacement attach to the named task session with UTF-8 tmux mode.
- [x] 1.3 Extend the shared resize path to continue forwarding provider PTY resize frames and best-effort apply `tmux resize-window` to the task's detached session.
- [x] 1.4 Add or update focused tests for tmux command generation, attach command generation, and best-effort detached-session resize behavior.

## 2. Track: boxlite-stream-utf8 (depends: none)

- [x] 2.1 Add stateful UTF-8 decoding to the BoxLite terminal transport for stdout and stderr output channels.
- [x] 2.2 Flush BoxLite decoder state on exit/close without emitting duplicate output or throwing during terminal teardown.
- [x] 2.3 Extend BoxLite transport tests with split multibyte stdout and stderr frame cases.

## 3. Track: verification (depends: tmux-utf8-resize, boxlite-stream-utf8)

- [x] 3.1 Run targeted API terminal source tests covering codex launch, codex autostart, terminal transport selection, BoxLite terminal transport, and reconnect/resize behavior.
- [x] 3.2 Re-run the local reproduction checks for tmux UTF-8 attach, split UTF-8 decoding, and detached tmux resize to confirm the implementation fixes the observed failure modes.
- [x] 3.3 Run `openspec validate --change fix-terminal-utf8-resize --strict` and address any proposal/spec/task validation failures.
- [x] 3.4 If a local dev or release-image stack is available, use Playwright to inspect a running task terminal and confirm Chinese output renders correctly and the terminal fills the available xterm area. (No local CAP dev/release-image stack was available on 127.0.0.1:3000/8080/18080, so the Playwright condition did not apply.)
