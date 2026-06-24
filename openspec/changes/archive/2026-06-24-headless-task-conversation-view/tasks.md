# Tasks

> Headless (MCP/`/v1`) tasks render the live xterm as raw codex-exec JSON — unreadable. They already
> have a readable 对话记录 when finished (rollout → rollout-parser → session-replay). Make the LIVE view
> the same conversation, polled (no WS/xterm), reusing rollout-parser + session-replay.
> User decisions: executionMode from the caller/consumer; reuse session-replay; no terminal record for
> headless anywhere; interactive untouched; poll (no WS); full re-parse per poll (STATELESS); rollout source.

## 1. Track: expose executionMode to the front-end

- [x] 1.1 Added `executionMode` (`interactive-pty` | `headless-exec`) to the task DTO — `ExecutionModeSchema` + field on `TaskSchema` in `@cap/contracts`; `tasks.service.toResponse` echoes it from the persisted column (null → `interactive-pty`). Additive, no migration.
- [x] 1.2 Front-end task type carries `executionMode` (flows via `TaskResponse`); mock tasks set it (a headless one for the branch). Round-trip asserted in `tasks-runtime.spec.ts` (findById echoes headless-exec; null → interactive-pty).

## 2. Track: backend — running headless transcript (live sandbox rollout, full re-parse)

- [x] 2.1 `session-history.controller` serves a RUNNING `headless-exec` task by reading its LIVE sandbox rollout via `readRolloutFromContainer` (works on a running container's frozen layer), returning the parsed transcript — NOT durable-first and NOT backfilled (backfilling an in-flight rollout would freeze an incomplete copy → stale). Interactive tasks keep the existing finished path. 5-state honest contract preserved.
- [x] 2.2 Full re-parse per poll (STATELESS — user decision): the whole rollout is read + `parseTranscript` runs once (pairing within the single pass); no offset, no cross-poll state, no parser refactor. Render-layer increment is react-query + `session-replay` re-render.
- [x] 2.3 Tests (`session-history.controller.test.mjs`, 54 pass): running headless → live read (no durable read, no backfill); running headless + no rollout yet → empty/no-rollout (starting); running INTERACTIVE → durable-first path unchanged (no live read). Also fixed a stale stub (readRolloutFromContainer returns `{format,jsonl}`).

## 3. Track: backend — no cast for headless

- [x] 3.1 `terminal.gateway.initCast` is async-gated on executionMode: a `headless-exec` task is NOT recorded (no `sessionCasts` entry → `appendCast` no-op → cast endpoint returns empty); interactive arms recording via the extracted `armCast` (resolve never throws → defaults to recording on a hiccup). Coverage: the empty-cast outcome is exercised by the POST-DEPLOY live verify (5.2); a gateway unit test is disproportionate (full DI + AioPtyClient) for an async one-line gate.

## 4. Track: front-end — branch the session view by executionMode

- [x] 4.1 `sessionViewMode(status, executionMode)` pure helper drives the `$taskId` branch: finished-replay / pre-running / headless-live (no WS, no xterm — SessionReplay) / live-terminal (interactive xterm, UNCHANGED).
- [x] 4.2 `SessionReplay` live mode: a `live` task polls session-history (`refetchInterval` 1.5s), accumulates turns (React diffs), shows a running meta + a starting state when the rollout has no turns yet; a finished view reads once.
- [x] 4.3 `SessionReplay` hides the 终端记录 tab and never fetches the cast when `executionMode === 'headless-exec'` (`showTermTab={executionMode !== 'headless-exec'}`); interactive still shows it. The session task also polls (refetchInterval while non-terminal) so a headless task flips to the finished replay on settle (no socket to reconcile it).
- [x] 4.4 Front-end tests (`session-view-mode.test.ts`, +5, node-env pure-logic per repo convention): running headless → headless-live; running interactive/null → live-terminal; any finished → finished-replay; pre-running → pre-running. (Render asserted via typecheck + the 5.2 live verify — vitest is node-env, no DOM.)

## 5. Track: verify (acceptance gate)

- [x] 5.1 `apps/web` typecheck + 245 tests green; `apps/api` typecheck + 434 tests green + `session-history.controller.test.mjs` 54 green; `contracts` typecheck green; change `openspec validate --strict` clean.
- [ ] 5.2 Live verify (POST-DEPLOY): a RUNNING headless (MCP) task shows a readable live conversation (commands + outputs with real newlines + agent messages, Chinese legible), updating as it runs, with NO terminal and NO 终端记录 tab; on completion it shows the same finished 对话记录. An interactive (console) task is visually unchanged (xterm live + 对话记录 + 终端记录).
