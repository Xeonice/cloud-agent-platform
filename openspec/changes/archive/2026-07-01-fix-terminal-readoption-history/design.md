## Context

CAP's interactive task model intentionally survives API restarts: the agent runs in a
detached named tmux session, the API re-adopts the sandbox on boot, and operators
reconnect through snapshot/tail replay. The current implementation treats every output
chunk observed through the reattached provider terminal as task history. That is wrong
for the initial attach sequence: tmux may echo launch/attach commands, report a
duplicate session, and repaint the current full-screen TUI frame. Those bytes restore a
viewer, but they are not new historical agent output.

The same readoption path also reinitializes `session.cast` recording by appending a new
asciicast header with a fresh timestamp base. A confirmed running task showed a second
header at the same second the API logged `re-adopted running task`, followed by event
time reset and duplicated TUI content.

## Goals / Non-Goals

**Goals:**

- Keep readoption and operator reconnect working for running interactive tasks.
- Keep `session.log` and `session.cast` as durable append-only history for real task
  output.
- Prevent reattach bootstrap output from becoming historical output.
- Make `session.cast` resumable across API restarts with one header and monotonic event
  times.
- Make reconnect snapshot offsets align with existing `session.log` after readoption.
- Render already-polluted legacy multi-header casts without presenting a time-reset
  segment as normal chronological history.

**Non-Goals:**

- No public REST endpoint or browser WebSocket protocol change.
- No front-end text dedupe of repeated terminal lines.
- No destructive migration or rewrite of existing workspace files.
- No change to the write-lease model or task lifecycle state machine.

## Decisions

### D1 - Carry output provenance below the TerminalPty seam

Provider terminal output should be able to say whether a chunk is recordable task output
or non-recordable bootstrap/repaint output. The gateway remains the owner of durable
history writes, but it must not infer provenance from byte contents.

Alternative considered: filter strings such as `duplicate session:` or tmux attach
commands in the gateway. Rejected because it is brittle, provider-specific, and risks
dropping legitimate user output.

### D2 - Treat re-adopt attach bootstrap as non-recordable

When `launch-or-attach` finds the detached session already alive, the immediate attach
phase is a viewer restoration phase. Its output should be streamed to the current live
connection and can seed the headless snapshot state, but it must not append to
`session.log` or `session.cast`. Once the attach bootstrap boundary passes, later output
from the live session is recordable again.

The exact boundary should be implemented by the terminal driver, not by a fixed sleep.
Acceptable implementation options include a scoped attach-bootstrap state cleared after
the first stable attach repaint/quiescence, or an explicit attach command completion
boundary if the provider transport exposes one.

### D3 - Resume cast recording from existing file state

`armCast()` should inspect the existing cast file:

- missing or empty file: write the header and start time at now;
- existing valid file: do not write a header, find the last valid event time, and set
  the new process-local start base so future events continue after that time;
- malformed file: degrade conservatively by not adding another header and by using the
  last valid event time if available.

This preserves asciicast v2 structure for new data and avoids a destructive migration.

### D4 - Rebase snapshot offsets during readoption

`SnapshotManager` currently tracks byte offset in memory. A fresh API process that
re-adopts a running task must initialize the offset from the existing durable
`session.log` size before appending new recordable output. Non-recordable attach
bootstrap bytes must not advance that durable offset. The headless terminal may still
need a viewer-restoration feed so future snapshots represent the current frame; that
state feed is separate from durable byte offset advancement.

### D5 - Legacy cast reader tolerates multi-header pollution

The cast parser/rendering path should detect mid-file headers or event time regression.
For legacy polluted files, it should prevent the later bootstrap segment from being
treated as ordinary chronological history. A conservative behavior is acceptable:
normalize segments to monotonic time only when safe, or drop a detected reattach
bootstrap segment that begins with shell/tmux attach output.

## Risks / Trade-offs

- Bootstrap boundary is subtle -> Add focused tests around alive-session attach output
  and avoid content-based filtering as the primary mechanism.
- Snapshot headless state can diverge from durable offset -> Keep two explicit actions:
  recordable output advances durable offset; non-recordable bootstrap may restore the
  visible frame without advancing offset.
- Existing polluted files cannot be perfectly repaired -> Provide graceful rendering for
  known multi-header/time-reset files and keep raw files unchanged.
- Provider differences may surface -> Put provenance in the provider-neutral terminal
  seam so AIO and BoxLite can share the same gateway behavior.

## Migration Plan

- Ship as a normal API/web change; no database migration is required.
- Existing workspace files remain untouched.
- New readoptions stop adding duplicate cast headers and stop recording attach bootstrap
  noise.
- Legacy polluted casts render through compatibility handling.
- Rollback restores old behavior but does not require data rollback.

## Open Questions

- What exact attach-bootstrap boundary is most reliable for both AIO and BoxLite
  transports: command-completion signal, quiescence, or a driver-level explicit attach
  mode?
- Should legacy multi-header casts be normalized in `parseCast()` or in the terminal
  record helper that builds render ops?
