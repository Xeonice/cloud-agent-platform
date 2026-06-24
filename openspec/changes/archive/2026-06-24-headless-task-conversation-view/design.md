# Design

## Context

`executionMode` (consumer-derived: `interactive-pty` for console, `headless-exec` for MCP/`/v1`) is
persisted on the task (`tasks.service`) but NOT exposed to the front-end. Headless runs `codex exec
--json` whose stdout (carried over the live WS `onRaw`) is structured JSON events; xterm renders it as
raw escaped JSON. Codex (incl. headless) writes a rollout to `~/.codex/sessions`; `session-history`
(`GET /tasks/:id/session-history`) parses the FINISHED task's frozen rollout via `rollout-parser` into
`SessionTurn`s, which `session-replay` renders as the 对话记录. So headless already has a readable
conversation when done — only the live view (and the cast) are JSON. Explored decisions (user-locked):
A2 (rollout source + reuse `rollout-parser`/`session-replay`), poll (no WS — headless's web entry is
read-only), incremental parsing, no cast for headless, interactive untouched.

## Goals / Non-goals

- **Goal:** a headless task's web view is a live, readable conversation (`session-replay`), updated by
  polling, with no terminal/WS/cast — and the same renderer for live and finished.
- **Non-goal:** changing interactive (`interactive-pty`) at all; changing codex's execution; a WS live
  channel for headless; rendering codex's exec-json stdout (we use the rollout, not stdout).

## Decisions

**D1 — `executionMode` exposed on the task response.** Add it to the task DTO (`TaskResponse`) from the
already-persisted column; the console branches the session view on it. No migration.

**D2 — Headless live = poll session-history, reuse `session-replay` (A2).** While a headless task is
running, the front-end POLLS the session-history endpoint (no WS, no xterm). The backend reads the
task's LIVE sandbox rollout and parses it with the existing `rollout-parser` into `SessionTurn`s — the
same parser + same `session-replay` renderer used for the finished transcript. Live and finished views
are identical, just one is polled.

**D3 — session-history serves a RUNNING headless task.** Today the endpoint reads the frozen rollout
from a stopped container (5-state honest contract). Extend it: for a RUNNING headless task, read the
live sandbox rollout (over `/v1/shell/exec`, as the finished-capture path already does) and return the
parsed transcript. Interactive running tasks are unaffected (they keep the WS/xterm; their history is
the existing finished path).

**D4 — Full re-parse per poll (STATELESS).** Each poll reads the WHOLE rollout — the existing
`readRolloutFromContainer` (via `container.getArchive`) already works on a RUNNING container's frozen
layer without stopping it — and runs the existing `parseRollout` once. Tool-call↔output pairing
completes WITHIN that single pass (the call and its output are both in the full file, unless the output
hasn't been written yet — in which case the next poll's full read picks it up), so NO cross-poll state
is needed and the endpoint stays stateless. The "increment" lives at the RENDER layer: react-query
updates and `session-replay` re-renders, with React diffing only the changed turns. Chosen (user)
over byte-offset incremental because a headless rollout is small (an exec one-shot, KB range) so
re-read + re-parse per poll is cheap, whereas offset-incremental would force a stateful pending-call
buffer onto an otherwise-stateless endpoint (lost on restart, inconsistent across instances). No
`rollout-parser` refactor is required.

**D5 — `session-replay` live mode.** `session-replay` currently fetches the transcript once on a
terminal-state branch. Add a live mode: poll while running, accumulate/merge turns (append new, replace
the last in-flight tool turn when its output arrives), show a running indicator, and auto-follow the
newest turn. On terminal status, stop polling and switch to the durable finished transcript.

**D6 — No cast for headless.** Front-end hides the 终端记录 tab when `executionMode === 'headless-exec'`
and never calls `getSessionCast`. Backend does not capture/persist a cast for headless tasks and the
cast endpoint returns the honest empty/absent state for them. (Interactive keeps the cast.)

**D7 — Interactive untouched.** `interactive-pty` keeps xterm live + WS + 对话记录 + 终端记录. The
branch is purely additive on the headless side.

**D8 — Poll cadence + termination.** Poll on a modest interval while running (e.g. ~1–2s, tunable);
stop when the task reaches a terminal status and load the durable finished transcript. Avoid
overlapping polls (skip if one is in flight). The endpoint stays cheap via the D4 stateless full
re-parse of a small rollout.

## Risks / Trade-offs

- **A tool call split across polls.** A `function_call` whose `function_call_output` isn't written yet
  shows as a tool turn with no output on one poll; the next poll's full re-parse (the whole rollout,
  re-paired in a single pass) completes it — ONE paired turn, never dropped/duplicated. Stateless, so
  there is no pending-call buffer and nothing to lose on restart.
- **Live sandbox rollout read cost.** Re-reading + re-parsing the WHOLE rollout each poll has a cost,
  but a headless rollout is small (an exec one-shot, KB range) and the cadence is modest, so it is
  cheap. Acceptable for a read-only view.
- **Two read paths in one endpoint.** Running-headless (live sandbox) vs finished (durable archive) in
  the same endpoint — keep the 5-state honest contract; add running as a populated state, not a faked
  one.

## Migration

None — `executionMode` is already persisted; this exposes it and adds a live read path. No schema/DB
change.

## Open Questions

- **`session-history-replay` — "Incremental read pairs a tool call split across polls" mechanism prose
  contradicts D4 (SPEC-DEFECT, not a code task).** The requirement scenario's prose mandates a
  byte-offset incremental read that "parses only newly-appended lines" and "carries tool-call↔output
  pairing state across reads". That mechanism is internally contradictory with the user-locked decision
  D4 (full re-parse per poll, STATELESS — no offset, no cross-poll pending-call buffer). The
  observable OUTCOME of the scenario (ONE paired tool turn, never dropped, never duplicated, even when
  `function_call` and `function_call_output` land on different polls) IS satisfied — each poll re-reads
  the whole rollout and re-pairs in a single `parseRollout` pass (`session-history.controller.ts`
  full-reparse path; covered by `session-history.controller.test.mjs`). The defect is in the requirement
  PROSE, which still describes the rejected offset-incremental mechanism. Action: reconcile the
  requirement wording with D4 (outcome-level: "a tool call split across polls resolves to one paired
  turn on a subsequent poll"), dropping the byte-offset/cross-read-state mandate. No code change — the
  code already meets the intended outcome.
