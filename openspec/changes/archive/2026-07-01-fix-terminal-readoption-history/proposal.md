## Why

Running interactive tasks can survive an API restart, but the readoption path currently
pollutes durable terminal history when CAP reattaches to the existing tmux session. A
confirmed live task on `vibe-zlyan` showed a second `session.cast` header, timestamp
reset, duplicate tmux launch/attach output, and repeated Codex TUI redraws after
readoption, which makes refreshed sessions and terminal records show duplicated or
out-of-order history.

## What Changes

- Make `session.cast` recording resumable across API restarts/readoption so a task has
  a single asciicast header and monotonically increasing event times.
- Prevent readoption/attach bootstrap output, including duplicate tmux launch messages
  and current-screen repaint, from being appended to durable historical streams.
- Rebase reconnect snapshot bookkeeping on the existing `session.log` when a running
  task is re-adopted so replay offsets remain aligned with the durable log.
- Harden cast parsing/rendering for already-polluted multi-header casts so legacy data
  does not display a time-reset segment as ordinary chronological history.
- Add focused unit and integration coverage for running task readoption, cast
  continuity, replay continuity, and legacy multi-header cast handling.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `sandbox-readoption`: readoption must reattach to a live session without recording
  attach bootstrap output as task history.
- `realtime-terminal`: reconnect replay must stay aligned to the durable `session.log`
  after API readoption and must not replay reattach bootstrap noise as historical output.
- `session-terminal-replay`: `session.cast` must remain a single continuous recording
  across readoption and the terminal record view must tolerate legacy multi-header casts.
- `terminal-execution`: `session.log` remains append-only for real task output, while
  reattach/bootstrap repaint bytes are explicitly not task-history bytes.

## Impact

- Affected backend code:
  - `apps/api/src/terminal/terminal.gateway.ts`
  - `packages/sandbox-provider-aio/src/aio-pty-client.ts`
  - provider-neutral terminal transport/output types if provenance needs to cross the
    `TerminalPty` seam
  - `packages/sandbox/src/terminal/snapshot.ts`
- Affected frontend/contracts code:
  - `packages/contracts/src/asciicast.ts`
  - `apps/web/src/components/session/cast-log.ts`
  - related tests for static terminal records
- No public REST or WebSocket API shape change is intended unless an internal
  provider-to-gateway output provenance type is needed.
- Existing `session.log` and `session.cast` files stay in place; no destructive
  migration is required.
