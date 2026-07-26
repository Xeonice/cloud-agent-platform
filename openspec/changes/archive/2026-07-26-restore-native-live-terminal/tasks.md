<!-- Track-annotated tasks. Each numbered group is a parallel Track. Tasks within a
     track run serially; independent tracks run in parallel at apply time. -->

## 0. Track: change-composition-preflight (depends: none)

- [x] 0.1 Before implementation, require `refactor-sandbox-provider-split` and `rework-sandbox-provider-center-and-e2e` to be completed and archived in dependency order, then complete/archive `enable-yolo-agent-launch`; do not archive this change ahead of any of those three because their stale deltas would restore snapshot/tail or inline/pre-YOLO runtime semantics.
  - requirements: ["realtime-terminal/provider-neutral-terminal-session-logic-lives-under-the-sandbox-center", "agent-runtime/codexruntime-interactive-launch-preserves-the-native-terminal-mode"]
  - surfaces: ["openspec", "developer-workflow"]
  - verify: "openspec-metadata"
- [x] 0.2 Rebase this change against the resulting canonical specs: retain the composed final `agent-runtime` requirement, and confirm the two `rework-sandbox-provider-center-and-e2e` requirements are now MODIFIED to fresh-attachment/current-frame fixture semantics rather than snapshot/tail replay.
  - requirements: ["agent-runtime/codexruntime-interactive-launch-preserves-the-native-terminal-mode", "realtime-terminal/web-provider-terminal-fixtures-verify-initial-render-and-reconnect"]
  - surfaces: ["openspec", "developer-workflow"]
  - verify: "openspec-metadata"
- [x] 0.3 Re-run strict validation for the rebased change and inspect the effective deltas before touching product code; block apply if any active change still modifies the same requirements incompatibly.
  - requirements: ["realtime-terminal/native-agent-terminals-pass-the-real-provider-release-gate"]
  - surfaces: ["openspec", "developer-workflow"]
  - verify: "openspec-metadata"

## 1. Track: terminal-contracts (depends: change-composition-preflight)

- [x] 1.1 Replace the live `snapshot`/`tail_replay`/offset-reconnect schemas in `packages/contracts` with versioned `terminal_attach`, `terminal_attachment_state`, `terminal_geometry`, and attachment-local `terminal_response` control frames; include a negotiated response-profile id in attach, keep raw frames and ACK sequencing connection-scoped, retain base64 input as explicitly opaque bytes, and do not alter finished-session REST/cast contracts.
  - requirements: ["realtime-terminal/dual-channel-websocket-stream", "realtime-terminal/the-live-path-preserves-native-terminal-protocol-bytes", "realtime-terminal/terminal-protocol-responses-return-to-the-originating-viewer-attachment"]
  - surfaces: ["contracts"]
  - verify: "contracts-registry"
- [x] 1.2 Define bounded schemas for attach outcomes (`attaching`/`ready`/`unavailable`/`failed`), geometry, explicit protocol/profile mismatch and reload-required behavior, and one atomic base64 terminal response per frame. Define a generated-or-validated profile keyed by exact resolved xterm version, termName, `disableStdin`/`windowOptions`, and response-affecting addons; the 5.5.0 profile covers DA1/DA2, DSR/normal-private CPR, ANSI/private DECRQM, DECRQSS, OSC 4/10/11/12 reports, and conditionally enabled window reports. Treat Gateway outstanding-query correlation, not syntax/profile membership alone, as the lease-independent authorization boundary.
  - requirements: ["realtime-terminal/terminal-protocol-responses-return-to-the-originating-viewer-attachment", "realtime-terminal/terminal-geometry-synced-to-the-sandbox-pty-on-connect", "realtime-terminal/terminalgateway-is-provider-neutral-and-remains-browser-facing"]
  - surfaces: ["contracts"]
  - verify: "contracts-registry"
- [x] 1.3 Update contract exports and focused tests so removed live replay frames are rejected, every new variant round-trips, unknown response profiles require reload before provider open, malformed/oversized/multi-response frames fail closed, opaque input base64 has no implicit UTF-8 semantics, cross-task control frames cannot rebind an attaching/attached socket, and raw/control channel discrimination remains intact.
  - requirements: ["realtime-terminal/dual-channel-websocket-stream", "realtime-terminal/browser-terminal-input-is-byte-preserving-and-lease-gated", "realtime-terminal/snapshot-plus-tail-replay-reconnect"]
  - surfaces: ["contracts", "ci"]
  - verify: "contracts-registry"

## 2. Track: viewer-attachment-core (depends: change-composition-preflight)

- [x] 2.1 Add provider-neutral `TerminalViewerAttachment`/factory/outcome types in `packages/sandbox-core`, separate from `AgentTerminalPty`: viewer attachments expose attach-existing, output, opaque-byte input (`Uint8Array`/Buffer without UTF-8 coercion), outer-PTY resize, pause/resume, ready/error outcome, and idempotent close, but no launch, liveness, recording, or sandbox teardown authority.
  - requirements: ["realtime-terminal/each-browser-connection-uses-a-fresh-attach-only-viewer-pty", "realtime-terminal/provider-neutral-terminal-session-logic-lives-under-the-sandbox-center", "sandbox-readoption/task-ownership-is-separate-from-disposable-viewer-attachments"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 2.2 Implement the shared viewer attachment in `packages/sandbox`: call `TerminalTransportFactory.open()` for every viewer, resize before attach, probe and attach the exact `=task<taskId>` session on the owner's default tmux socket with `-f ignore-size`, and never use `tmux -L`, `new-session`, or launch fallback in the product path.
  - requirements: ["sandbox-provider-port/interactive-terminal-providers-expose-fresh-disposable-ptys", "sandbox-readoption/task-ownership-is-separate-from-disposable-viewer-attachments", "realtime-terminal/each-browser-connection-uses-a-fresh-attach-only-viewer-pty"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 2.3 Forward every tmux attach byte and later live byte while deriving a bounded first-output/quiet-or-deadline ready signal only for UI reveal; document that ready is not a protocol frame-end proof for continuously repainting TUIs, and do not suppress SMCUP, clear, cursor, style, terminal-query, or current-frame repaint bytes.
  - requirements: ["realtime-terminal/live-frame-parity-under-pty-parity-conditions", "realtime-terminal/the-live-path-preserves-native-terminal-protocol-bytes", "realtime-terminal/each-browser-connection-uses-a-fresh-attach-only-viewer-pty"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 2.4 Fence asynchronous open/close with AbortSignal plus an internal generation, make close idempotent, keep pause/resume and resize attachment-local, and return typed absent/indeterminate/failed outcomes instead of a successful blank attachment.
  - requirements: ["sandbox-provider-port/disposable-terminal-lifecycle-and-flow-control-are-isolated", "realtime-terminal/each-browser-connection-uses-a-fresh-attach-only-viewer-pty"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 2.5 Refactor `configured-terminal.ts` exports so callers can resolve both the one task owner and repeatable viewer factories from the same selected provider descriptor without exposing provider URLs or credentials.
  - requirements: ["realtime-terminal/provider-neutral-terminal-session-logic-lives-under-the-sandbox-center", "realtime-terminal/terminalgateway-is-provider-neutral-and-remains-browser-facing", "sandbox-readoption/task-ownership-is-separate-from-disposable-viewer-attachments"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 2.6 Add deterministic fake-transport tests for distinct opens, exact attach target, resize-before-attach ordering, complete idle redraw, no history-prefix injection, live continuation, all-byte input preservation, stale callback fencing, independent pause/close, and no launch on every unsuccessful attach outcome.
  - requirements: ["sandbox-provider-port/provider-conformance-covers-terminal-executor-workspace-and-ownership-contracts", "sandbox-provider-port/interactive-terminal-providers-expose-fresh-disposable-ptys", "sandbox-provider-port/disposable-terminal-lifecycle-and-flow-control-are-isolated"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"
- [x] 2.7 Extend the provider terminal transport seam with an explicit opaque-byte write path used by viewer input and terminal responses. Implement and characterize it without converting through UTF-8 in the AIO adapter; if AIO's native JSON protocol cannot losslessly represent required bytes, surface a failed capability/conformance outcome instead of silently degrading or hardcoding a fixture exception. The BoxLite adapter follows in its lifecycle track.
  - requirements: ["realtime-terminal/the-live-path-preserves-native-terminal-protocol-bytes", "realtime-terminal/browser-terminal-input-is-byte-preserving-and-lease-gated", "sandbox-provider-port/provider-conformance-covers-terminal-executor-workspace-and-ownership-contracts"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"

## 3. Track: boxlite-transport-lifecycle (depends: viewer-attachment-core)

- [x] 3.1 Harden `BoxLiteTerminalTransport` asynchronous creation with a closed latch and AbortController: close-before-`POST /exec` completion SHALL prevent a late attach WebSocket and best-effort close the exact late execution without leaking the API token.
  - requirements: ["sandbox-provider-port/disposable-terminal-lifecycle-and-flow-control-are-isolated", "realtime-terminal/terminal-transport-abstracts-provider-protocol-details"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 3.2 Make repeated `factory.open()` calls produce independent execution ids, opaque-byte input/output, resize, pause/resume, error, and close state; one viewer close or backpressure event must not affect peers or the sandbox.
  - requirements: ["sandbox-provider-port/interactive-terminal-providers-expose-fresh-disposable-ptys", "sandbox-provider-port/disposable-terminal-lifecycle-and-flow-control-are-isolated", "realtime-terminal/browser-terminal-input-is-byte-preserving-and-lease-gated"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 3.3 Add BoxLite transport tests for close-before-create, late create success/failure, repeated close, concurrent opens, fragmented UTF-8 output, full-range/legacy-mouse binary input, independent resize/backpressure, exact cleanup evidence, and secret absence in errors/logs.
  - requirements: ["sandbox-provider-port/provider-conformance-covers-terminal-executor-workspace-and-ownership-contracts", "sandbox-provider-port/disposable-terminal-lifecycle-and-flow-control-are-isolated", "boxlite-sandbox-provider/boxlite-terminal-output-preserves-streaming-utf-8"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"
- [x] 3.4 Ensure a BoxLite task owner can be reopened attach-only by the provider-neutral owner supervisor after transport loss, with the same absent/indeterminate/no-launch fencing and stale-generation cleanup as AIO.
  - requirements: ["sandbox-readoption/task-owner-transport-is-actively-supervised-without-viewer-input", "sandbox-readoption/a-running-task-survives-an-api-restart-or-redeploy", "realtime-terminal/fresh-viewer-attachment-remains-aligned-after-api-readoption"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 3.5 Replace direct child-PTY bytes on BoxLite's lossy per-chunk UTF-8 output route with the image-owned fixed-path ASCII/canonical-base64 child-PTY bridge. Gate normalized ready on a matching `R`, route opaque input/terminal responses/resize through bounded `I`/`S` frames, fail closed on missing/malformed/stale/out-of-sequence frames, retain exact DELETE+GET404 cleanup, and cover a real forkpty shell plus arbitrary provider fragmentation, split code points, every input byte, ready/close races, and identity-free errors.
  - requirements: ["boxlite-sandbox-provider/boxlite-terminal-capability-requires-an-image-owned-byte-bridge", "boxlite-sandbox-provider/boxlite-terminal-output-preserves-streaming-utf-8", "realtime-terminal/the-live-path-preserves-native-terminal-protocol-bytes"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"

## 4. Track: native-runtime-owner (depends: change-composition-preflight)

- [x] 4.1 Remove `--no-alt-screen` from interactive Codex runtime argv, AIO fallback launch material, both sandbox image contracts, and golden expectations; remove `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` only from interactive Claude Code launch while leaving headless behavior unchanged.
  - requirements: ["agent-runtime/codexruntime-interactive-launch-preserves-the-native-terminal-mode", "agent-runtime/claudecoderuntime-launch-line-and-sandbox-flags", "realtime-terminal/a-headless-task-opens-no-live-terminal"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 4.2 Reconcile the same runtime files with active change `enable-yolo-agent-launch`: the composed final interactive launch retains Codex `--dangerously-bypass-approvals-and-sandbox`, Claude `--dangerously-skip-permissions`, and Claude's dangerous-mode setting while changing only terminal-mode overrides; eliminate or characterize every duplicate fallback so no provider silently restores inline mode or pre-YOLO flags.
  - requirements: ["agent-runtime/codexruntime-interactive-launch-preserves-the-native-terminal-mode", "agent-runtime/claudecoderuntime-launch-line-and-sandbox-flags", "agent-runtime/agentruntime-port-abstracts-per-agent-execution-seams"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 4.3 Keep the single provider-neutral task owner (AIO `AioPtyClient` or BoxLite owner transport) responsible for launch/startup DSR/autosubmit, liveness, runtime classification, readoption, and canonical output; add generation-fenced active supervision so an established owner transport close triggers exact-session probe plus attach-only bounded backoff/jitter without browser input, and never launch on absent/indeterminate recovery.
  - requirements: ["sandbox-readoption/task-owner-transport-is-actively-supervised-without-viewer-input", "sandbox-readoption/task-ownership-is-separate-from-disposable-viewer-attachments", "realtime-terminal/provider-neutral-terminal-session-logic-lives-under-the-sandbox-center"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 4.4 Update runtime, AIO autostart, codex-launch, Dockerfile contract, and headless characterization tests so, relative to the composed YOLO baseline, the only terminal-specific Codex interactive argv delta is no-alt removal, Claude default alternate mode is allowed, and auth/model/prompt/exit/transcript behavior stays pinned.
  - requirements: ["agent-runtime/codexruntime-interactive-launch-preserves-the-native-terminal-mode", "agent-runtime/claudecoderuntime-launch-line-and-sandbox-flags", "agent-runtime/codex-observable-outputs-are-byte-identical-and-characterization-tested"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"
- [x] 4.5 Add owner-supervision tests for unexpected close with zero viewers, alive attach-only redial, indeterminate retry/degraded timeout, absent unobserved-exit failure, stale-generation callbacks, no concurrent recorder, no relaunch, and observable outage/settle duration.
  - requirements: ["sandbox-readoption/task-owner-transport-is-actively-supervised-without-viewer-input", "sandbox-readoption/a-running-task-survives-an-api-restart-or-redeploy", "sandbox-readoption/readoption-bootstrap-is-excluded-from-bounded-owner-evidence"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"

## 5. Track: api-terminal-gateway (depends: terminal-contracts, viewer-attachment-core)

- [x] 5.1 Refactor `TerminalSession` into one `ownerPty`/recorder plus a repeatable viewer factory and authoritative `{cols, rows}`; refactor `ClientState` to own an explicit unattached/attaching/attached/closed phase, one disposable attachment, frozen non-secret `{principalIdentity, boundTaskId, generation}`, an auth-attempt epoch/cancellation fence, subscription, connection-scoped seq/ACK/backpressure, desired geometry, internal cancellation state, bounded parser carry, and a bounded TTL-scoped FIFO outstanding-terminal-query queue cleared on close/replacement. Preserve the resolved principal's stable kind/user/key identity as applicable, never the raw credential.
  - requirements: ["realtime-terminal/provider-neutral-terminal-session-logic-lives-under-the-sandbox-center", "realtime-terminal/terminal-protocol-responses-return-to-the-originating-viewer-attachment", "sandbox-readoption/task-ownership-is-separate-from-disposable-viewer-attachments"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 5.2 Implement the one-WebSocket/one-attachment handshake: at the synchronous acceptance point of the first valid attach, before awaiting the task owner's launch/attach decision or any provider probe/open, atomically enter attaching, freeze principal/task/generation, invalidate older auth attempts, and consume that socket's sole attach attempt; then open a fresh viewer in attach-only mode and emit explicit attaching/ready/unavailable/failed states. Fail closed on a second attach, concurrent/late auth resolution, `connect_auth` retarget during attaching or after attach, cross-task client frame, stale generation, disconnect, or auth failure; cancel pending work and exact-close any late provider result while touching neither target task.
  - requirements: ["realtime-terminal/each-browser-connection-uses-a-fresh-attach-only-viewer-pty", "realtime-terminal/terminalgateway-is-provider-neutral-and-remains-browser-facing", "sandbox-provider-port/disposable-terminal-lifecycle-and-flow-control-are-isolated"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 5.3 Stop fanning owner bytes to browsers. Keep owner output as the sole lifecycle/activity/runtime-classification/bounded-evidence source; suppress bootstrap/resize repaint only through producer eligibility. Keep raw `session.log`/`session.cast` policy separate so default-off artifacts cannot disable classification, and ensure viewer bootstrap/repaint/responses/duplicate live output never enter owner evidence or an opt-in artifact.
  - requirements: ["realtime-terminal/gateway-owned-recording-and-replay-are-provider-independent", "sandbox-readoption/readoption-bootstrap-is-excluded-from-bounded-owner-evidence", "terminal-execution/session-log-records-task-output-not-attach-bootstrap-repaint"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 5.4 Remove live `SnapshotManager`/headless-xterm/tail-replay work from connect and readoption, then delete only reconnect-specific code/tests that have no bounded evidence/structured transcript consumer. Retain filename/API compatibility for explicit opt-in diagnostics, but do not preserve an unbounded whole-file read or make full raw history a default finished surface.
  - requirements: ["realtime-terminal/snapshot-plus-tail-replay-reconnect", "realtime-terminal/the-live-terminal-preserves-a-scrollable-history", "realtime-terminal/reconnect-replay-remains-aligned-after-api-readoption"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 5.5 Bind each `BackpressureController` to its viewer attachment so a high-water mark pauses/resumes only that provider PTY; add a configurable per-task viewer limit and make overflow, timeout, and transport failure explicit rather than blank.
  - requirements: ["realtime-terminal/server-side-backpressure-with-bounded-high-water-mark", "realtime-terminal/ack-based-pause-resume-control-frames", "sandbox-provider-port/disposable-terminal-lifecycle-and-flow-control-are-isolated"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 5.6 Parse every active-profile query with a side-effect-free hard-bounded observer while preserving raw output byte-for-byte, including arbitrary fragmentation, 7-bit/C1 transport forms, CSI/OSC/DCS, BEL/ST, and bounded negative/stacked forms without recognizing query-looking bytes inside unrelated strings. Enqueue the correct number of parameterized tokens before trigger-byte delivery in a bounded FIFO with explicit full-queue refusal plus secure default/hard-max TTL whose non-finite, non-positive, or over-max config blocks activation. Apply exact DA, DSR/CPR, ANSI/private DECRQM, DECRQSS, OSC color, and conditionally enabled window-report mappings; atomically consume the oldest match before an opaque-byte provider write without restoring on failure. Bind validate/consume/write to one live generation so close/replacement/auth failure/task unregister prevents a post-close write; reject unmatched/replayed/expired/cross-attachment/task/generation frames. Keep all human input, including `onBinary`, lease-gated, while consuming matching response tokens embedded in an authorized writer's mixed burst only for single-use accounting before its one byte-for-byte keystroke write.
  - requirements: ["realtime-terminal/terminal-protocol-responses-return-to-the-originating-viewer-attachment", "realtime-terminal/the-live-path-preserves-native-terminal-protocol-bytes", "realtime-terminal/browser-terminal-input-is-byte-preserving-and-lease-gated"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 5.7 Make only the lease holder authoritative for geometry: apply its connect/resize/takeover size through the owner/tmux explicit resize path, synchronize owner and all viewer outer PTYs, broadcast the canonical grid, ignore reader/stale resize, and append exactly one cast resize event only when bounded cast recording is explicitly enabled; cast-off creates no pending resize state.
  - requirements: ["realtime-terminal/terminal-geometry-synced-to-the-sandbox-pty-on-connect", "sandbox-readoption/concurrent-attach-to-a-task-session-is-single-writer", "realtime-terminal/gateway-owned-recording-and-replay-are-provider-independent"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 5.8 Update gateway, concurrent-attach, readoption, backpressure, runtime-failure, WebSocket validation, and provider-story tests for independent PTY identities, quiet/continuous ready, and principal/task binding frozen before async owner/provider work. Include pending-open retarget and pre-attach auth resolving late; every task-scoped frame including heartbeat and pending-approval decision; raw parser transparency; every-byte-boundary recognition; 7-bit/C1 CSI plus OSC/DCS BEL/ST; nested/query-looking payload rejection; malformed/endless carry recovery and close-clear; invalid/non-finite/non-positive/over-hard-max TTL config; fake-clock acceptance at `now < expiresAt`, rejection/pruning at `now >= expiresAt`, and expired-token pruning reclaiming capacity before full-queue refusal; full live-queue no-eviction; interleaved-class FIFO oldest-match; exact positive/negative/profile-invalid matrices for DA, DSR/CPR, ANSI/private DECRQM known/unknown/boundary modes, the five known DECRQSS subtypes plus bounded unknown representatives, OSC 4 single/multiple indexes, OSC 10/11/12 stacked slots, and disabled/enabled window reports, with CSI 18 equal to authoritative rows/cols and CSI 14/16 positive attachment-local pixels inside hard bounds; dynamic-parameter and cross-class mismatches; same-call-stack response proving enqueue-before-delivery; rate limits; concurrent single-consume; write-failure no-restore; and close/replacement/auth/task-unregister races before validation, after validation, and after consume with no old-PTY write. Also cover opaque binary input, single-writer authority, owner/API evidence gaps, unobserved exit failure, bounded cleanup, and no snapshot/tail frames.
  - requirements: ["realtime-terminal/terminal-protocol-responses-return-to-the-originating-viewer-attachment", "realtime-terminal/browser-terminal-input-is-byte-preserving-and-lease-gated", "realtime-terminal/terminalgateway-is-provider-neutral-and-remains-browser-facing"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"
- [x] 5.9 Update the provider-backed story service/fixture to launch one owner plus multiple disposable viewers, emit a deterministic styled alternate-screen frame after a long uniquely marked prefix, expose query/response/provider-write inventories plus a byte-oracle for UTF-8 and legacy mouse input, support live/input/resize probes, and clean owner/viewer/tmux/provider resources on success and failure.
  - requirements: ["realtime-terminal/provider-backed-terminal-story-uses-cap-gateway", "realtime-terminal/web-provider-terminal-fixtures-verify-initial-render-and-reconnect", "sandbox-provider-port/provider-conformance-covers-terminal-executor-workspace-and-ownership-contracts"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"
- [x] 5.10 Implement the capacity-safe native release slice: default-disable log/cast independently; enforce configurable byte and pending-write budgets before enqueue; keep bounded owner failure evidence/classification/activity/exit independent; prevent cast-off resize state; reject disabled/oversized casts before payload read; surface honest Web states; and add parameterized focused regressions without fixture-specific product exceptions.
  - requirements: ["terminal-execution/opt-in-raw-terminal-writers-are-hard-bounded-before-enqueue", "session-terminal-replay/honest-empty-state", "realtime-terminal/gateway-owned-recording-and-replay-are-provider-independent"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"

## 6. Track: web-native-terminal (depends: terminal-contracts)

- [x] 6.1 Update `ws-client.ts` to send one versioned terminal-attach request with the validated response-profile id per WebSocket for one immutable task binding, treat raw seq/ACK as connection-local, never retarget an attaching/attached socket, consume attachment state/geometry frames, and surface protocol/profile mismatch or attach failure as an explicit reconnect/reload state.
  - requirements: ["realtime-terminal/dual-channel-websocket-stream", "realtime-terminal/terminalgateway-is-provider-neutral-and-remains-browser-facing", "realtime-terminal/terminal-geometry-synced-to-the-sandbox-pty-on-connect"]
  - surfaces: ["contracts"]
  - verify: "public-surface-fast"
- [x] 6.2 Simplify the live branch of `session-terminal.tsx`: on attaching, fully reset the existing xterm and hide it behind a reconnect status; feed every raw bootstrap/live byte unchanged, reveal after bounded ready plus xterm write flush, allow continuous post-reveal convergence without calling ready a complete-frame marker, and never wait for snapshot/tail history.
  - requirements: ["realtime-terminal/each-browser-connection-uses-a-fresh-attach-only-viewer-pty", "realtime-terminal/live-frame-parity-under-pty-parity-conditions", "realtime-terminal/the-live-path-preserves-native-terminal-protocol-bytes"]
  - surfaces: ["contracts"]
  - verify: "public-surface-fast"
- [x] 6.3 Remove live uses of `stripAltScreen*`, reconnect replay queues/watchdogs, `lastSeq`, snapshot geometry, and scrollback viewport synchronization while preserving rAF write coalescing, ACK-after-flush, xterm readiness fallback, copy/fullscreen, and normal reconnect backoff.
  - requirements: ["realtime-terminal/snapshot-plus-tail-replay-reconnect", "realtime-terminal/the-live-terminal-preserves-a-scrollable-history", "realtime-terminal/reconnect-replay-remains-aligned-after-api-readoption"]
  - surfaces: ["contracts"]
  - verify: "public-surface-fast"
- [x] 6.4 Build the terminal-response profile and `terminal-input-filter.ts` against the production shared Terminal wrapper's exact resolved xterm version, termName, options, and addons. Keep `disableStdin=false` for readers; only a whole `onData` burst that losslessly tokenizes into complete active-profile responses with no remainder may be split in order into one atomic `terminal_response` frame per response. Never extract a response substring from incomplete, mixed, ambiguous, or trailing-human data; preserve that complete burst on the lease-gated keystroke path, where server-side matching is accounting only and never bypasses the lease.
  - requirements: ["realtime-terminal/terminal-protocol-responses-return-to-the-originating-viewer-attachment", "realtime-terminal/browser-terminal-input-is-byte-preserving-and-lease-gated", "realtime-terminal/the-live-path-preserves-native-terminal-protocol-bytes"]
  - surfaces: ["contracts"]
  - verify: "public-surface-fast"
- [x] 6.5 Extend the shared Terminal and session input plumbing to subscribe to `onBinary`, UTF-8 encode `onData`, convert each `onBinary` JS binary-string code unit to its low 8-bit byte, and base64 the resulting explicit bytes without a binary-path UTF-8 round trip; Gateway-side lease and frozen-binding checks remain authoritative and `onBinary` never becomes `terminal_response`.
  - requirements: ["realtime-terminal/browser-terminal-input-is-byte-preserving-and-lease-gated", "realtime-terminal/the-live-path-preserves-native-terminal-protocol-bytes"]
  - surfaces: ["contracts"]
  - verify: "public-surface-fast"
- [x] 6.6 Apply server-authoritative geometry to every live xterm; only report local fit as task geometry while the client owns the lease, and re-report the new writer's desired geometry after takeover without recreating its PTY.
  - requirements: ["realtime-terminal/terminal-geometry-synced-to-the-sandbox-pty-on-connect", "sandbox-readoption/concurrent-attach-to-a-task-session-is-single-writer"]
  - surfaces: ["contracts"]
  - verify: "public-surface-fast"
- [x] 6.7 Keep `cast-log.ts`/`SessionCastLog` only as an opt-in bounded diagnostic renderer; remove live imports/calls, and make disabled/too-large/unavailable states explicit without fetching/mounting raw replay by default or mislabeling them empty.
  - requirements: ["session-terminal-replay/cast-read-endpoint", "session-terminal-replay/honest-empty-state", "realtime-terminal/gateway-owned-recording-and-replay-are-provider-independent"]
  - surfaces: ["contracts"]
  - verify: "public-surface-fast"
- [x] 6.8 Add a finite Playwright source-conformance matrix using the production wrapper for DA1/DA2, DSR/normal-private CPR, ANSI/private DECRQM known/unknown/boundary mode representatives, all five known DECRQSS payloads plus bounded unknown equivalence representatives, OSC 4 single/multiple and OSC 10/11/12 stacked reports with boundary indexes, BEL/ST, 7-bit/C1 forms, current-disabled and isolated-enabled window reports, exact profile fingerprint drift, and `onData` versus `onBinary` mouse bytes. Also cover native alternate-buffer/cursor/style/CJK state, exact byte ordering, quiet-frame equivalence, continuous deadline reveal, failure UI, writer/reader resize, response-only multi-token and mixed/ambiguous bursts, writer accounting, unsolicited/replayed/expired/cross-task rejection, and an unmasked non-empty screenshot.
  - requirements: ["realtime-terminal/local-xterm-story-verifies-terminal-rendering-behavior", "realtime-terminal/terminal-protocol-responses-return-to-the-originating-viewer-attachment", "realtime-terminal/native-agent-terminals-pass-the-real-provider-release-gate"]
  - surfaces: ["contracts", "ci"]
  - verify: "public-surface-fast"

## 7. Track: provider-and-browser-stories (depends: boxlite-transport-lifecycle, native-runtime-owner, api-terminal-gateway, web-native-terminal)

- [x] 7.1 Promote `scripts/terminal-fresh-attach-canary.mjs` into the shared opt-in conformance harness: retain its isolated `-L capfresh...` safety mode for ad-hoc remote validation, and add a product-equivalent mode using a unique exact session on the same default tmux socket as the owner with exact-session cleanup only.
  - requirements: ["sandbox-provider-port/provider-conformance-covers-terminal-executor-workspace-and-ownership-contracts", "realtime-terminal/provider-backed-terminal-story-uses-cap-gateway", "sandbox-provider-port/disposable-terminal-lifecycle-and-flow-control-are-isolated"]
  - surfaces: ["ci", "developer-workflow"]
  - verify: "api-mcp"
- [x] 7.2 Run the same stateful provider conformance for AIO and BoxLite: distinct owner/viewer PTY identities; 50,000+ unique history markers; complete idle current-frame redraw with alternate buffer, cursor, attributes, color and CJK; no historical prefix; exactly-once live delta; third-PTY reconnect; full-range/representative high-byte and legacy-mouse opaque input verified by a PTY byte oracle; independent pause/close; and verified cleanup.
  - requirements: ["realtime-terminal/native-agent-terminals-pass-the-real-provider-release-gate", "sandbox-provider-port/provider-conformance-covers-terminal-executor-workspace-and-ownership-contracts", "realtime-terminal/the-live-path-preserves-native-terminal-protocol-bytes"]
  - surfaces: ["ci", "developer-workflow"]
  - verify: "api-mcp"
- [x] 7.3 Add multi-viewer gateway stories for writer input, reader input rejection across `onData`/`onBinary`, complete active-profile query inventory and correlated reader replies, unsolicited/replayed/expired/cross-viewer/close-cleared/unsupported response rejection, cross-task `connect_auth` and every task-scoped control-frame rejection both while provider open is pending and after attach, late-auth resolution fencing, writer-only resize/takeover, a slow viewer, full disconnect, owner transport redial, and API readoption without relaunch or false continuity claims.
  - requirements: ["realtime-terminal/terminal-protocol-responses-return-to-the-originating-viewer-attachment", "realtime-terminal/browser-terminal-input-is-byte-preserving-and-lease-gated", "sandbox-readoption/concurrent-attach-to-a-task-session-is-single-writer"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"
- [x] 7.4 Update the provider-backed Playwright app to use only CAP's WebSocket and compare uninterrupted versus fresh-attach canonical screen state plus unmasked screenshots at identical geometry; fail on blank/partial/stale frames, snapshot/tail controls, provider URL exposure, or resource leakage.
  - requirements: ["realtime-terminal/web-provider-terminal-fixtures-verify-initial-render-and-reconnect", "realtime-terminal/provider-backed-terminal-story-uses-cap-gateway", "realtime-terminal/live-frame-parity-under-pty-parity-conditions"]
  - surfaces: ["contracts", "ci"]
  - verify: "public-surface-fast"
- [x] 7.5 Make every story opt-in and fail closed on explicit provider selection; audit success, assertion failure, timeout, cancellation, and process-signal paths to prove temporary viewer PTYs, tmux clients/session, BoxLite executions/box, AIO fixture socket/session, listeners, and credentials are removed without touching unrelated sandboxes.
  - requirements: ["realtime-terminal/provider-backed-terminal-story-uses-cap-gateway", "sandbox-provider-port/disposable-terminal-lifecycle-and-flow-control-are-isolated", "sandbox-provider-port/provider-conformance-covers-terminal-executor-workspace-and-ownership-contracts"]
  - surfaces: ["ci", "developer-workflow"]
  - verify: "api-mcp"

## 8. Track: real-release-verification (depends: provider-and-browser-stories)

- [x] 8.1 Run strict OpenSpec validation, affected package typechecks/lint/unit/integration suites, full terminal contract/gateway/web/provider tests, production-wrapper response-profile source conformance, and `git diff --check`; fail on exact xterm/options/addons fingerprint drift and fix product code rather than weakening or hardcoding tests.
  - requirements: ["realtime-terminal/native-agent-terminals-pass-the-real-provider-release-gate", "realtime-terminal/terminal-protocol-responses-return-to-the-originating-viewer-attachment", "sandbox-provider-port/provider-conformance-covers-terminal-executor-workspace-and-ownership-contracts"]
  - surfaces: ["ci", "developer-workflow", "openspec"]
  - verify: "public-surface-full"
- [x] 8.2 On local real BoxLite, run actual interactive Codex and Claude Code in default terminal mode through CAP: verify long/high-frequency output, a quiet non-empty frame, continuous deadline reveal, keyboard/paste/focus plus SGR `onData` and legacy/default `onBinary` mouse behavior, writer resize, complete disconnect/reconnect, multiple viewers, and cleanup with Playwright screenshots, canonical screen evidence, and a PTY byte oracle. Inventory every observed terminal query, browser response, and provider write from a read-only viewer; require each active-profile query to be mapped/correlated exactly once, or evidence that pinned xterm emits no response and omission does not alter screen/control flow. Block native-default on any unmapped response, indeterminate effect, or rewritten/duplicated binary byte.
  - requirements: ["realtime-terminal/native-agent-terminals-pass-the-real-provider-release-gate", "boxlite-sandbox-provider/boxlite-terminal-capability-requires-an-image-owned-byte-bridge", "realtime-terminal/terminal-protocol-responses-return-to-the-originating-viewer-attachment"]
  - surfaces: ["ci", "developer-workflow"]
  - verify: "api-mcp"
- [x] 8.3 On remote `bwg-jp` AIO, repeat the real Codex/Claude matrix and deterministic 50k pressure test; verify fresh provider terminal ids, same business tmux socket/exact target, bounded current-frame bytes, no history prefix, exactly-once live continuation, high-byte/legacy-mouse input with the PTY byte oracle, and the same exhaustive query/browser-response/provider-write correlation gate as BoxLite. Unsupported runtime rejection remains required but cannot pass release when pinned xterm would respond, the effect is unknown, or AIO's native protocol cannot preserve required bytes. Also verify no secret exposure and no leftover canary/session/process resources.
  - requirements: ["realtime-terminal/native-agent-terminals-pass-the-real-provider-release-gate", "sandbox-provider-port/provider-conformance-covers-terminal-executor-workspace-and-ownership-contracts", "realtime-terminal/the-live-path-preserves-native-terminal-protocol-bytes"]
  - surfaces: ["ci", "developer-workflow"]
  - verify: "api-mcp"
- [x] 8.4 Restart the API and separately drop the owner transport during real provider/runtime runs: prove an alive agent session is attach-only re-adopted/redialed by exactly one owner without input, each browser gets a new viewer PTY, absent/indeterminate sessions never launch, an agent ending while unobserved takes the explicit orphan failure path, bounded evidence/classification resumes after settling, viewer redraw never enters owner evidence, and real-CLI reports owner-absent/settle duration with missing bytes marked unknown.
  - requirements: ["sandbox-readoption/task-owner-transport-is-actively-supervised-without-viewer-input", "sandbox-readoption/a-running-task-survives-an-api-restart-or-redeploy", "realtime-terminal/fresh-viewer-attachment-remains-aligned-after-api-readoption"]
  - surfaces: ["ci", "developer-workflow"]
  - verify: "api-mcp"
- [x] 8.5 Verify the approved capacity boundary under default alternate-screen long output: default deployments create neither `session.log` nor `session.cast`, cast-off resize state stays empty, runtime auth classification/activity/exit and structured transcript remain independent, and finished Web reports raw history disabled rather than empty without mounting xterm. Separately opt in each artifact with injected budgets to prove exact byte/pending-write bounds, one valid truncation marker, no later enqueue, valid cast JSONL, and disabled/oversized controller paths that perform no payload read. The measured 1.284GB cast/1.04GB log result is the evidence for keeping full raw history deferred, not a gate to re-enable it.
  - requirements: ["terminal-execution/opt-in-raw-terminal-writers-are-hard-bounded-before-enqueue", "session-terminal-replay/honest-empty-state", "realtime-terminal/gateway-owned-recording-and-replay-are-provider-independent"]
  - surfaces: ["ci", "developer-workflow"]
  - verify: "api-mcp"
- [x] 8.6 Verify rollout and rollback boundaries: protocol or response-profile mismatch produces reload-required rather than blank success, unverified xterm/options/addons drift cannot negotiate the old profile, rolling back the coordinated API/Web build does not kill detached tasks, viewer limits/backpressure emit observable metrics, and all BoxLite/AIO cleanup evidence is captured.
  - requirements: ["realtime-terminal/native-agent-terminals-pass-the-real-provider-release-gate", "realtime-terminal/terminalgateway-is-provider-neutral-and-remains-browser-facing", "sandbox-readoption/a-running-task-survives-an-api-restart-or-redeploy"]
  - surfaces: ["ci", "developer-workflow"]
  - verify: "public-surface-full"
- [x] 8.7 Write `verification-report.md` with commands, exact response-profile fingerprint, versions, task/session ids, screen hashes/screenshot paths, query/browser-response/provider-write inventories, opaque-byte oracle results, byte/latency measurements, default raw-off/no-file evidence, opt-in budget/truncation evidence, real owner-outage durations with missing byte count explicitly unknown, cleanup proof, and unsupported terminal behavior; mark the native path release-ready only when every real-provider/runtime gate passes, no xterm-generated response is unmapped/indeterminate, both providers preserve required binary input, and raw history remains default-off.
  - requirements: ["realtime-terminal/native-agent-terminals-pass-the-real-provider-release-gate", "sandbox-provider-port/provider-conformance-covers-terminal-executor-workspace-and-ownership-contracts", "realtime-terminal/terminal-protocol-responses-return-to-the-originating-viewer-attachment"]
  - surfaces: ["docs", "ci", "developer-workflow"]
  - verify: "public-surface-full"
