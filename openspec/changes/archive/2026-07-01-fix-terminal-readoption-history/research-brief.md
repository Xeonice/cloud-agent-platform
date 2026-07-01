# Research Brief

## Problem Evidence

The live `vibe-zlyan` task `12c791c7-87df-4150-a941-d94bb4374460` confirmed that
terminal history corruption happens during API readoption of a still-running task.

Observed artifacts from the API container workspace:

- `/data/workspaces/<taskId>/session.cast` contains two asciicast headers:
  - line 1: timestamp `2026-07-01T08:34:18Z`
  - line 2457: timestamp `2026-07-01T12:49:33Z`
- The event immediately after the second header resets time from `13608.181` seconds
  to `0.147` seconds.
- The second segment contains a repeated launch attempt, `duplicate session:
  task12c791c7-...`, another tmux attach command, and a Codex TUI screen redraw.
- `/data/workspaces/<taskId>/session.log` contains the same duplicate launch/attach
  evidence: two `tmux -u new-session` occurrences, one `duplicate session:`, and
  three attach commands.
- API logs at the same second as the second cast header contain:
  `re-adopted running task 12c791c7-87df-4150-a941-d94bb4374460`.

This proves the corruption is not a React render-order issue. The durable terminal
history files are polluted during readoption/reattach.

## Relevant Existing Capabilities

- `sandbox-readoption`: already specifies that running tasks survive API restarts and
  that CAP reattaches to a live detached session instead of launching a new agent.
- `realtime-terminal`: owns live terminal WebSocket reconnect, `session.log` replay,
  snapshot/tail replay, and provider-neutral terminal transport behavior.
- `session-terminal-replay`: owns `session.cast` recording and the static terminal
  record tab.
- `terminal-execution`: owns the general rule that PTY output is appended to
  `session.log`.

The change should modify existing capabilities rather than introduce a new one.

## Code Pointers

- `apps/api/src/terminal/terminal.gateway.ts`
  - `onPtyOutput()` writes every provider terminal output chunk to both
    `session.log` and `session.cast`.
  - `appendSessionLog()` serializes append order for `session.log`.
  - `armCast()` always appends a new asciicast header when a gateway instance
    registers cast recording for a task, even if the file already exists.
- `packages/sandbox-provider-aio/src/aio-pty-client.ts`
  - `launchOrAttachOnReady()` attaches to an existing named session when it is alive.
  - Attach output currently has no provenance marker distinguishing the initial tmux
    attach repaint from new agent output.
- `packages/sandbox-provider-aio/src/codex-launch.ts`
  - `buildAttachSessionCommand()` builds the tmux attach command whose echoed output
    appears in the polluted history.
- `packages/contracts/src/asciicast.ts`
  - `parseCast()` treats only the first non-blank line as the header and parses
    later lines as events, dropping a later header but keeping the events after it.
- `apps/web/src/components/session/cast-log.ts`
  - `buildCastOps()` processes parsed events in file order and has no segment/time
    normalization for corrupted multi-header casts.

## Design Constraints

- Do not solve by front-end text dedupe; repeated lines may be legitimate terminal
  output.
- Preserve readoption: the task must remain running and attach must still restore the
  operator's current visible screen.
- Preserve durable history: historical task output must stay append-only and ordered.
- Existing polluted casts should degrade gracefully instead of showing time-reset
  segments as if they were ordinary historical output.

## Candidate Fix

1. Make cast recording resumable:
   - Write the asciicast header only for a missing or empty `session.cast`.
   - When a cast exists, find the last valid event time and continue the new process'
     event timestamps from that offset.
2. Track terminal output provenance through the provider terminal seam:
   - Mark readoption/attach bootstrap repaint as non-recordable.
   - Stream non-recordable output to the current operator and headless snapshot
     restoration as needed, but do not append it to `session.log` or `session.cast`.
3. Rebase the `SnapshotManager` on existing durable `session.log` during readoption so
   later reconnect offsets stay aligned with the file.
4. Harden cast parsing/rendering for legacy multi-header files by detecting mid-file
   headers or time regressions and preventing the second bootstrap segment from
   corrupting the displayed terminal record.
