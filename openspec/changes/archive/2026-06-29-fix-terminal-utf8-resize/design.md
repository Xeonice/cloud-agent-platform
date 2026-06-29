## Context

The live terminal stack has three layers involved in the observed failure:

- Browser xterm auto-fits to the visible task page and sends cols/rows when the terminal WebSocket opens.
- `TerminalGateway` forwards geometry to the shared `AioPtyClient` seam and records output through `session.log`, `session.cast`, and snapshots.
- The shared terminal client launches or attaches to an authoritative detached tmux session, while provider transports translate AIO JSON or BoxLite terminal frames below that seam.

Local verification found two independent UTF-8 hazards and one geometry hazard. Plain tmux attach under a non-UTF-8 locale can render Chinese as underscores unless tmux is forced into UTF-8 mode. BoxLite stdout/stderr frames can split multibyte UTF-8 code points, and the current per-frame `payload.toString('utf8')` corrupts those sequences. Detached tmux sessions also start at `80x24` unless explicitly created or resized, so resizing only the outer provider PTY can leave the inner full-screen TUI narrow.

## Goals / Non-Goals

**Goals:**

- Preserve Chinese and other multibyte UTF-8 output in live terminals across AIO and BoxLite-backed tasks.
- Keep the detached tmux session's authoritative window size aligned to the browser terminal geometry after connect, reconnect, and resize.
- Keep the browser-facing terminal protocol unchanged.
- Add focused tests that exercise the exact failure modes: tmux command generation, split UTF-8 BoxLite frames, and tmux resize propagation.

**Non-Goals:**

- Change the browser WebSocket protocol or expose provider-native terminal URLs.
- Replace tmux or remove the detached-session survival model.
- Add a locale-management feature or require images to set a UTF-8 locale globally.
- Redesign the terminal page layout.

## Decisions

### D1 - Force tmux clients into UTF-8 mode

Use `tmux -u` for detached session creation and attach/probe commands that participate in the live terminal session. This addresses tmux's client-side interpretation of pane output without requiring every sandbox image to have a UTF-8 locale installed.

Alternative considered: export `LANG`/`LC_ALL` before launching agents. That can help child processes, but it does not fully cover tmux client rendering under a non-UTF-8 attach environment and is image-dependent.

### D2 - Stream-decode BoxLite stdout/stderr

Use stateful UTF-8 decoders per BoxLite output channel before emitting `output` frames into CAP's shared terminal pipeline. This preserves code points split across provider WebSocket frames while keeping the rest of the gateway pipeline string-based for now.

Alternative considered: change `TerminalTransportFrame` output data to `Uint8Array` end-to-end. That would be a larger cross-module protocol refactor. The current bug can be fixed at the provider transport boundary with less blast radius.

### D3 - Resize the detached tmux window as part of terminal resize

When browser geometry reaches `AioPtyClient.resize(cols, rows)`, continue forwarding the provider PTY resize and also best-effort resize the detached tmux window with `tmux resize-window -t task<id> -x <cols> -y <rows>`. This makes the authoritative full-screen TUI redraw at the browser geometry.

Alternative considered: create the detached tmux session with the browser geometry. The launch usually happens before the browser socket has reported geometry, and reconnects/resizes still need runtime updates, so creation-time sizing alone is insufficient.

### D4 - Keep resize best-effort and bounded

The tmux resize command should be best-effort and not block hot output/input paths. If the session is not yet alive or has exited, the existing provider resize and liveness handling remain authoritative.

Alternative considered: fail the task when tmux resize fails. That would turn a display synchronization problem into task failure and would be too aggressive for reconnect races.

## Risks / Trade-offs

- **Risk:** Golden tests are byte-exact and will fail broadly after adding `tmux -u`.
  **Mitigation:** Update the launch/attach characterization tests deliberately and add explicit assertions for UTF-8 mode.
- **Risk:** A resize frame can arrive before the detached session exists.
  **Mitigation:** Treat `tmux resize-window` as best-effort and continue resizing again on later open/reconnect/resize frames.
- **Risk:** Stateful BoxLite decoders need flushing on close/exit to avoid dropping trailing partial bytes.
  **Mitigation:** Flush decoders when the terminal closes or an exit frame is observed, and cover split-frame behavior in tests.
- **Risk:** Provider transports may encode stderr/stdout independently.
  **Mitigation:** Keep separate decoders for stdout and stderr channels.

## Migration Plan

1. Implement the terminal seam changes behind existing interfaces.
2. Run focused API terminal tests and BoxLite transport tests.
3. Validate locally with the reproduced tmux UTF-8, split-frame UTF-8, and resize checks.
4. After implementation is accepted, publish and redeploy through the release-image path so the remote BoxLite deployment uses the fixed API image.

Rollback is the normal release rollback path: redeploy the previous release image. No database or persistent data migration is involved.

## Open Questions

None. The local reproduction is sufficient to proceed with an implementation plan.
