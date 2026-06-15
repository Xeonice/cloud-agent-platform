<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: contracts-session-history (depends: none)

- [x] 1.1 Add a `SessionHistoryResponse` discriminated schema to `packages/contracts/src/session-history.ts`: a Zod discriminated union over the five honest states (rollout-transcript for completed; rollout + interrupted-terminal indication for cancelled; rollout-to-failure for failed; empty-with-reason for agent-failed-to-start / provision-failed-no-rollout; empty-aged-out for expired/reaped), where the not-running/expired/no-rollout conditions are explicit states, never errors.
- [x] 1.2 Define the structured render-contract item types in the same module: a user item (operator prompt text only, wrapper stripped), a final-answer assistant item (`phase == 'final_answer'`), a commentary assistant item (any other phase), a tool-call item (name/arguments/`call_id` + inline token count), and a tool-output item linked by `call_id`.
- [x] 1.3 Export the new schema and item types from `packages/contracts/src/index.ts` so both the api and web packages can import them.
- [x] 1.4 Add a contracts unit test (`packages/contracts/src/session-history.test.mjs`) asserting each discriminator parses/round-trips and that an empty state never carries fabricated transcript items.

## 2. Track: rollout-parser (depends: contracts-session-history)

- [x] 2.1 Implement a pure rollout parser module under `apps/api/src/sandbox/` (e.g. `rollout-parser.ts`) that consumes `rollout-*.jsonl` lines (`{timestamp, type, payload}`) and emits the `@cap/contracts` render-contract items — NOT `history.jsonl`.
- [x] 2.2 Categorize assistant `output_text` blocks by the explicit `phase` field (`phase == 'final_answer'` → final answer; any other phase → commentary), with NO message-ordering / last-assistant heuristic.
- [x] 2.3 Map a `response_item` `function_call` to a tool-call item (name/arguments/`call_id`) and link its `function_call_output` to a tool-output item by matching `call_id`; surface the `event_msg token_count` as the inline token count on the tool-call item.
- [x] 2.4 Split the developer/instruction wrapper off a user prompt payload on the known delimiter so only the operator's own text remains in the user item.
- [x] 2.5 Add a parser unit test (`apps/api/src/sandbox/rollout-parser.test.mjs`) covering the phase split, `call_id` linkage, wrapper stripping, and token-count attachment against fixture rollout lines.

## 3. Track: provider-retention (depends: none)

- [x] 3.1 In `apps/api/src/sandbox/aio-sandbox.provider.ts` flip container creation to `HostConfig.AutoRemove: false` (`:179`) so the Docker daemon does not auto-remove the container on process exit.
- [x] 3.2 Split `teardownSandbox` (`:231-244`) into a STOP-ONLY path: stop the container and DO NOT issue `remove`, so the frozen filesystem (rollout + workspace + `~/.codex/sessions`) survives; keep slot-release behavior unchanged (slot freeing is independent of removal).
- [x] 3.3 Add the pre-stop `/home/gem/.codex` trim over `/v1/shell/exec` BEFORE the stop call (`:426` region): delete the codex cache and `logs_*.sqlite`, KEEP `/home/gem/.codex/sessions/` and the workspace, and clear/zero `/home/gem/.codex/auth.json`; a trim/clear failure SHALL NOT block the stop+retain.
- [x] 3.4 Change the `onApplicationBootstrap` reap (`:261-287`) to remove ONLY RUNNING orphan `cap-aio-*` containers, filtering on container STATE (only RUNNING) + the `cap-aio-*` identity + age, so STOPPED retained history containers survive a Dokploy redeploy / api restart.
- [x] 3.5 Add a method on the provider that reads `rollout-*.jsonl` out of a STOPPED `cap-aio-<taskId>` container via dockerode `getContainer(id).getArchive()` (untar the tar stream, glob `rollout-*.jsonl`, never `history.jsonl`), without restarting the container and without exporting `auth.json` or any credential file.
- [x] 3.6 Update `apps/api/src/sandbox/aio-sandbox.provider.test.mjs` to cover AutoRemove=false, stop-only teardown (Exited not removed), pre-stop trim-keeps-sessions + auth clear, trim-failure-still-retains, RUNNING-only reap sparing stopped containers, and the getArchive rollout read.

## 4. Track: session-history-endpoint (depends: rollout-parser, provider-retention)

- [x] 4.1 Add a `GET /tasks/:id/session-history` controller (new file under `apps/api/src/tasks/`, following the `metrics.controller.ts:33-36` convention) covered by the global `APP_GUARD`, returning the discriminated `SessionHistoryResponse`.
- [x] 4.2 Wire the controller to read the rollout via the provider `getArchive` method, run the rollout parser, and map the terminal task status (`completed`/`cancelled`/`failed`/`agent_failed_to_start`/`provision_failed`→failed, plus expired/reaped when the container is gone) to the correct discriminated state — never fabricating transcript content, never throwing for not-running/expired/no-rollout.
- [x] 4.3 Register the new controller in its NestJS module (`tasks.module.ts` or the sandbox module per real coupling) and confirm the endpoint stays a standalone REST surface that never touches the live WebSocket / PTY / write-lease path.
- [x] 4.4 Add an endpoint test (`apps/api/src/tasks/session-history.controller.test.mjs`) covering: completed→rollout, cancelled→rollout+interrupted, failed→rollout-to-failure, no-rollout failure→empty-with-reason, expired/reaped→empty-aged-out, auth-required, and credentials-never-exported.

## 5. Track: retention-cleaner (depends: provider-retention)

- [x] 5.1 Add a retention-cleaner module wired in the guardrails layer (new file under `apps/api/src/guardrails/`, e.g. `retention-cleaner.ts`) modeled on `CodexDeviceLoginService`'s unref'd `setInterval` + `docker getContainer().remove({force})`, injecting `SettingsService`/`PrismaService` to resolve the retention window (`stored?.retention ?? 30`, `DEFAULT_RETENTION_DAYS = 30`).
- [x] 5.2 Implement Policy 1 (age): remove a STOPPED `cap-aio-*` container whose stopped age exceeds the resolved retention window; only ever target STOPPED + `cap-aio-*` containers and NEVER a RUNNING one.
- [x] 5.3 Implement Policy 2 (free-disk high-water-mark): when host free disk drops below the configured floor, evict OLDEST-stopped `cap-aio-*` containers FIRST until free disk recovers above the floor, even for containers younger than the window.
- [x] 5.4 Add the in-process `isRunning` overlap guard so a slow sweep never overlaps the next tick, and document the single-instance assumption (no distributed lock) in the module.
- [x] 5.5 Add a cleaner test (`apps/api/src/guardrails/retention-cleaner.test.mjs`) covering age-trip removal, 30-day default vs persisted-settings resolution, low-disk oldest-first eviction, running-never-reaped, and the overlap guard skipping a re-entrant tick.

## 6. Track: guardrails-teardown-callsites (depends: provider-retention)

- [x] 6.1 In `apps/api/src/guardrails/guardrails.service.ts` confirm `onTerminal` (`:442-460`) routes through the stop-only `teardownSandbox` so a naturally-completed task is retained while its slot is still freed.
- [x] 6.2 Confirm `forceFail` (`:544-572`) routes through the stop-only `teardownSandbox` for all 5 abnormal causes (deadline / idle / circuit-breaker / abnormal-exit / provision-failed), including SIGKILL'd exits, retaining the container while freeing the slot.
- [x] 6.3 Instantiate/inject and start the retention cleaner from `guardrails.service.ts` (or `guardrails.module.ts`) so the periodic sweep runs in the guardrails layer.
- [x] 6.4 Extend the guardrails exit/roundtrip tests (`guardrails-exit-roundtrip.test.mjs` / `guardrails-bootstrap.test.mjs`) to assert teardown at both chokepoints is stop-only-retain with slot still freed, and that bootstrap reap sparing of stopped containers holds end-to-end.

## 7. Track: web-data-seam (depends: contracts-session-history)

- [x] 7.1 Add `queryKeys.sessionHistory(id)` and a `sessionHistoryQuery` to `apps/web/src/lib/api/queries.ts`, with `queryFn = isCapable(domain) ? real.getSessionHistory(id) : mock(...)`, mirroring the existing `taskResourceQuery` seam.
- [x] 7.2 Implement `real.getSessionHistory(id)` in `apps/web/src/lib/api/real.ts` using `request(path)` against `GET /tasks/:id/session-history` and validating the payload with the `@cap/contracts` `SessionHistoryResponse` Zod `.parse` before returning.
- [x] 7.3 Add a `getSessionHistory` mock fallback to `apps/web/src/lib/api/mock.ts` (and `mock-session.ts` if used) returning a representative discriminated payload across the five states.
- [x] 7.4 Add the session-history capability flag to `apps/web/src/lib/api/capabilities.ts` so the real/mock selection is gated like the metrics seam.
- [x] 7.5 Extend the capability-seam test (`capability-seam.test.ts` / `mock.test.ts`) to assert `sessionHistoryQuery` picks real-vs-mock by the flag and that `real.getSessionHistory` `.parse`-validates the contract.

## 8. Track: web-replay-ui (depends: web-data-seam)

- [x] 8.1 Build the read-only structured replay component(s) under `apps/web/src/routes/_app/tasks/` (or a colocated components dir) per `design-baseline/history-replay-preview.html`: two tabs 对话记录 (primary, parsed rollout) / 终端回放 (secondary, `session.log` cold-replay) and a review sidebar with a search input + the five sticky filter presets 默认 / 无工具 / 用户 / 答案 / 全部.
- [x] 8.2 Render the three conversation item kinds with their fixed treatments: final-answer green-tinted with a "最终回答" label, commentary muted-italic and visually distinct, and tool-call as a bordered card showing the tool badge, command summary, and inline token count.
- [x] 8.3 Implement the filter semantics (无工具 hides tool-calls; 用户 shows only user turns; 答案 shows user prompts plus final answers) and the search input over the parsed transcript.
- [x] 8.4 Render the honest empty states (会话未能启动 with the failure reason for agent-failed-to-start / provision-failed-no-rollout; 会话记录已过期 for expired/reaped) instead of a fabricated transcript, driven by the discriminated response.
- [x] 8.5 Wire the terminal-state branch of `apps/web/src/routes/_app/tasks/$taskId.tsx` (`:115-121`, `:178-196`) so a `completed`/`cancelled`/`failed` task renders the replay region (NO live WebSocket, NO live-input surface, NO resume/stop control) inside the preserved three-segment cockpit header, leaving the live-terminal path unchanged for non-terminal tasks.
- [x] 8.6 Verify the reorganized terminal-state page against the design baseline (Playwright screenshot compare against `design-baseline/history-replay-preview.html`) and confirm a live running task still connects its terminal, before marking complete.

## Track: verify-reopened (depends: none)

- [x] V.1 Carry the cancelled-task interrupted-terminal indication in the WIRE session-history response (`packages/contracts/src/session-history.ts` + `apps/api/src/tasks/session-history.controller.ts`). Spec "Session-history response is a discriminated honest 5-state contract" / scenario "Cancelled task returns rollout plus interrupted indication" requires the response carry the parsed rollout transcript AND an interrupted-terminal indication for a `cancelled` task. Today the `available` branch of `SessionHistorySchema` has no `isInterrupted` field and the controller returns `{ status: 'available', turns, meta }` identically for completed/cancelled/failed — it never reads `task.status`. Add the indication to the `available` schema branch and set it from `task.status === 'cancelled'` in the controller; extend `session-history.controller.test.mjs` for cancelled→rollout+interrupted at the wire level.
- [x] V.2 Zero `auth.json` on the PROVISION-FAILURE retention path (`apps/api/src/sandbox/aio-sandbox.provider.ts`). When `provision()` catches a post-start error it calls `teardownSandbox(ctx.taskId)` at `:237` BEFORE `this.connections.set(...)` at `:242`, so `teardownSandbox`'s `if (connection)` guard at `:262` is false and `trimCodexHomeBeforeStop` (the `auth.json` zero, `:296-324`) is SKIPPED — yet the container is stopped-and-retained (the spec's "Abnormally-terminated tasks are still retained" scenario lists `provision-failed` as a retained cause). A provision that failed AFTER `injectCodexAuth` (`:224`) — e.g. in `injectTaskPrompt`/`cloneTaskRepository` — therefore retains a live `auth.json`, violating "retained containers do not hold a usable credential". Ensure the pre-stop trim/clear runs on the provision-failure teardown (e.g. trim using the in-scope `baseUrl`, or set the connection before the failing post-start steps so the existing guard fires); cover it in `aio-sandbox.provider.test.mjs`.
- [x] V.3 RESOLVED via spec deferral (the operator deferred session.log work; spec requirement + scenario amended to make the `终端回放` tab a placeholder and the `session.log` cold-replay an explicit deferred follow-up — see design.md "Deferred scope"). The honest `终端回放待接入` placeholder is the agreed in-scope state.
