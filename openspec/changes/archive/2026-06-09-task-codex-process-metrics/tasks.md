<!-- Track-annotated tasks. Within a track tasks run serially; independent tracks
     run in parallel. Track 1 is a real-machine spike GATE for the sampler rework. -->

## 1. Track: spike (depends: none)

- [x] 1.1 Method A (`/proc`-walk) spiked live via codex-driven probe in a real `cap-aio` sandbox: `/proc/<pid>/stat` carries utime=170/stime=122 (CLK_TCK=100), `VmRSS`≈126 MB present, nproc=6 — CPU-delta + RSS feasible. ✓
- [x] 1.2 Method B (dedicated cgroup) spiked: **INFEASIBLE** — `/sys/fs/cgroup` is read-only inside the sandbox (`mkdir` → `Read-only file system`), `subtree_control` empty, gem uid 1000 unprivileged → cannot create/delegate a sub-cgroup.
- [x] 1.3 **DECISION: method A** (B infeasible). Recorded in `design.md` D1 with evidence. Key datum: codex RSS ≈126 MB vs container ≈1.5 GiB (~12× overstatement) — confirms the bug quantitatively.
- [x] 1.4 PID discovery confirmed: `pgrep -x codex` → a single unambiguous PID (832). Subtree walk uses `/proc/<pid>/task/<pid>/children` (empty when codex is idle; children appear only while running tools — the walk must be dynamic per tick).

## 2. Track: contracts (depends: none)

- [x] 2.1 `packages/contracts/src/metrics.ts`: added `TaskResourceScopeSchema` + `scope` to the `sampled` variant of `TaskResourceResponse` and a `container: ContainerResourceSampleSchema.nullable()` background reading (`sample` = primary). Aggregate `/metrics` block (`SampledResources`/`ContainerResourceSample`) unchanged.
- [x] 2.2 Contracts test `task-resource-scope.test.mjs` (5/5): process-scope carries codex primary + container background; container-scope fallback carries container + null; not-running parses; bad scope rejected; aggregate `MetricsResponse` unaffected.

## 3. Track: sampler (depends: spike, contracts)

- [x] 3.1 `resource-sampler.service.ts` — carry-forward (`carryForwardContainers` + `containerMisses`, bound `CARRY_FORWARD_MAX=3`): a still-running task unread on a tick reuses its prior reading up to N ticks, dropped only when it leaves the running set (`pruneStale`) or exceeds N. Cold-outage stays `unavailable` (doesn't cache empty-available while tasks run).
- [x] 3.2 `resource-sampler.service.ts` — in-sandbox codex process sampling (method A): `CODEX_PROC_PROBE` (recursive `/proc` subtree walk) via `POST /v1/shell/exec` (`AbortSignal.timeout` = cadence), `parseProcProbe` pure parser, per-task CPU-delta baseline (`previousProcessCpu`), `scope: 'process'` primary in `processSamples`.
- [x] 3.3 `resource-sampler.service.ts` — container fallback: `taskReading` returns `scope: 'container'` (container aggregate, null background) when no process sample; process miss carries forward (bounded) then falls back. Process pass runs even on a container outage.
- [x] 3.4 `metrics.service.ts` — `buildTaskResource` is a thin mapper of `sampler.taskReading()` → `{scope, sample, container, sampledAt, ageMs}`; `not-running` only when `taskReading` is null (no live reading).
- [x] 3.5 N/A — method B (cgroup) ruled infeasible by the spike; NO codex launch change.
- [x] 3.6 Tests: `resource-sampler-process.test.mjs` (8/8) — parseProcProbe, carry-forward keeps-then-drops at the bound, taskReading process-primary/container-fallback/null; `task-resource.test.mjs` rewritten (3/3) for the scope mapper; `metrics.verify.test.mjs` 15/15 (cold-outage regression fixed). api tsc 0, eslint 0.

## 4. Track: web (depends: contracts)

- [x] 4.1 New pure `apps/web/src/components/session/format-resource.ts` (`formatTaskResource` + `formatBytes`); `$taskId.tsx` uses it — codex primary + container background by `scope`, "未运行/未采样" only when there's no live reading (a carried-forward reading still shows numbers).
- [x] 4.2 `mock.ts` `mockTaskResource` returns the new `scope: 'process'` + dual reading (codex ~126MB primary + container background); `real.getTaskResource` parses the updated `TaskResourceResponseSchema` automatically (no change needed).
- [x] 4.3 Web vitest `format-resource.test.ts` — process primary + container background, container fallback, null-pct omission, not-running/loading; mock.test.ts validates `mockTaskResource` against the schema. 54/54; tsc 0, eslint 0.

## 5. Track: verify-and-docs (depends: spike, contracts, sampler, web)

- [x] 5.1 Static gates GREEN: contracts build + `task-resource-scope` (5); api `tsc` 0 / eslint 0 / nest build; web `tsc` 0 / eslint 0 / vitest 54; metrics suites — `resource-sampler-process` (8), `task-resource` (3), `metrics.verify` (15), `resource-sampler` regress. No `debugger`.
- [ ] 5.2 Live verify (POST-DEPLOY, pending): two concurrent tasks — neither flickers to `not-running` while quiet; per-task readout shows codex `scope: process` (≈126 MB vs container ≈1.5 GiB) and falls back to `scope: container` when the in-sandbox read is forced unavailable. (Requires deploy; not committed/deployed per the standing no-push rule.)
- [x] 5.3 Docs: `design.md` D1 records method A + spike evidence; `.env.example` documents `METRICS_SAMPLING_ENABLED` now drives the codex-process pass + the carry-forward/fallback behavior + cadence tunables. Carry-forward bound is the code constant `CARRY_FORWARD_MAX=3`; no NEW env var (the process pass reuses the existing sampling flag).
