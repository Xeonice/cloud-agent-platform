## ADDED Requirements

### Requirement: A running headless task serves a live, polled transcript

For a RUNNING headless task (`executionMode = headless-exec`), the session-history endpoint SHALL serve
the live transcript by reading the task's SANDBOX rollout (over `/v1/shell/exec`, as the finished
capture path does) and parsing it with the SAME `rollout-parser` used for a finished task — so the live
and finished views use one parser and one `session-replay` renderer. Each poll is a STATELESS full
re-parse (the whole rollout is read and parsed once; tool-call↔output pairing completes WITHIN that
single pass — no byte offset, no cross-poll state), so a `function_call` whose `function_call_output`
is not yet written yields a tool turn with no output on one poll, and the next poll's full re-parse —
now seeing the written output — yields ONE completed tool turn (never dropped, never duplicated). The
console SHALL POLL this
endpoint while the headless task runs (no WebSocket), render the accumulating turns via `session-replay`
with a running indicator, and switch to the durable finished transcript on terminal status. Interactive
(`interactive-pty`) tasks are unaffected.

#### Scenario: Running headless task returns a live transcript

- **WHEN** the console requests session-history for a RUNNING headless task
- **THEN** the backend reads the live sandbox rollout and returns the parsed transcript (populated, not the not-running empty state), using the same `rollout-parser` / `SessionTurn` contract as a finished task

#### Scenario: A tool call whose output lands on a later poll yields one paired turn

- **WHEN** one poll re-parses a `function_call` whose `function_call_output` is not yet written, and a later poll re-reads the now-complete rollout
- **THEN** the result is ONE completed tool turn (the later full re-parse pairs the call and its output within a single pass) — not dropped, not duplicated

#### Scenario: Console polls while running, switches on terminal

- **WHEN** a headless task is running
- **THEN** the console polls session-history on a modest cadence and renders the accumulating turns via `session-replay`; **WHEN** the task reaches a terminal status, polling stops and the durable finished transcript is loaded

#### Scenario: Interactive tasks keep the existing finished-only path

- **WHEN** an `interactive-pty` task is viewed
- **THEN** its live view remains the xterm/WS terminal and its session-history remains the finished-task path — unchanged by this requirement
