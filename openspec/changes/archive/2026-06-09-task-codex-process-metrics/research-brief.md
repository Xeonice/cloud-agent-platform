# Research Brief — task-codex-process-metrics

Side-car research (not a tracked artifact). Grounded by live probing of the
production stack + direct codebase reads during `/opsx:explore`. Every claim
carries a `file:line` anchor or a live observation.

## 1. The trigger

The operator reported: the per-task sandbox resource readout "只要沙箱不是用户
操作活跃状态就拿不到数据" (shows no data unless the sandbox is being actively
operated), and "应该是监控当前启动进程的" (it should monitor the launched
process). Two distinct problems surfaced.

## 2. Live ground truth (production, task 59fb6ebd, captured via page-context fetch)

A single quiet running task, polled directly against `GET /tasks/:id/metrics`
6× over 24s with codex idle (CPU dropped 131%→2.3%):
- ALL 6 returned `state: "sampled"`, CPU ~2.4%, fresh (ageMs ~1.3s), task `running`,
  in the running set, container in `resources.containers`.
- → "codex idle → not-running" is FALSE for a single task: the backend samples a
  running container continuously, independent of codex activity or operator
  attendance. The frozen "131%" I first saw in the UI was **background-tab
  throttling** of the 5s poll (a stale value), NOT `not-running`.

Container-vs-codex (same task, live):
| | codex busy | codex idle |
|---|---|---|
| container CPU | 131% | 2.3% |
| container memory | 1.4 GiB | 1.5 GiB |
- Container CPU tracks codex (good proxy). Container MEMORY is ~constant ~1.5 GiB —
  dominated by the AIO sandbox's OWN services, NOT codex; codex's own RSS is hidden.

## 3. Problem 1 — the `not-running` flicker (real, but needs concurrency)

The session readout `未运行 / 未采样` comes ONLY from the backend returning
`{state:'not-running'}` (`apps/web/src/routes/_app/tasks/$taskId.tsx` resourceBody:
`state==='not-running' → "未运行 / 未采样"`; the undefined/loading branch shows
"加载运行规格…"). So the backend returned not-running for a running task.

`buildTaskResource` returns `not-running` iff the task's container is absent from
`currentSnapshot().containers` (`apps/api/src/metrics/metrics.service.ts:55-67`).
The container is absent iff `readContainers` skipped it this tick. `readContainers`
(`resource-sampler.service.ts:367-404`): per task, cgroup read (fails inside the
api container → fallback) then `docker stats({stream:false})` with
`withTimeout(cadenceMs=5000)`; a container readable by NEITHER is SKIPPED. Then
`buildSampledResources(readings,…)` rebuilds the WHOLE snapshot from only this
tick's successes (`:110-160`).

- Single task: all-fail → `throw` (`:400-402`) → `sampleOnce` keeps the PRIOR
  snapshot (`:336-346`) → stays `sampled` (masked). **Proven live: single task never
  flips.**
- **≥2 tasks**: if one container's stats times out / 404s while another succeeds →
  `readings` non-empty → no throw → snapshot rebuilt WITHOUT the missed container →
  that task → `not-running` for that tick. This is the only static path to
  not-running for a running task, and it matches the operator's phrasing: the task
  you're IN is the only-or-active one (fine); the OTHER concurrent sandboxes you're
  not operating flicker to not-running on a sampling race. (Not reproduced
  multi-task live — would need a 2nd sandbox — but the code path is conclusive.)

Sampler running-source is the semaphore (`metrics.module.ts:56-58` →
`guardrails.semaphoreProjection().snapshotRunning()`), populated admit→onTerminal
(`semaphore.ts:156,162`), independent of operator connection
(`terminal.gateway.ts:422-450` handleDisconnect only clears the operator's own
subscription + write lease, never the per-task `AioPtyClient`). So a running task
is always in the sampled set — confirming the flicker is the per-container skip,
not a running-set drop.

## 4. Problem 2 — the metric measures the CONTAINER, not codex

The orchestrator samples from OUTSIDE via docker stats / cgroup
(`resource-sampler.service.ts:415-488`), which can only yield the container
aggregate (all PIDs: AIO HTTP server, tmux, node, supervisord, … + codex). Live
data shows memory is dominated by the sandbox baseline, so the readout misrepresents
"codex's usage" (esp. memory).

To measure codex specifically, the orchestrator MUST read from INSIDE the sandbox —
the only channel is `POST /v1/shell/exec`, already used for clone / auth / prompt /
skills (`aio-sandbox.provider.ts:371,449,503,572` + `parseExecResponse` `:625`).
codex runs as a foreground `codex` process in a tmux shell
(`codex-launch.ts:52-60` `buildCodexLaunchLine`: `… codex "$P"`), so it is
`pgrep`-able. No per-codex sub-cgroup exists today (codex shares the container root
cgroup) — a dedicated cgroup would require changing the launch + cgroup delegation
inside the sandbox (unverified — gem uid 1000).

## 5. Decisions (operator, this explore)

- **Report:** codex process-tree as the PRIMARY readout + container total as
  background/context.
- **Method:** run BOTH spikes (A `/proc`-walk via exec; B dedicated cgroup v2 scope)
  on a throwaway sandbox, compare accuracy/cost/feasibility, then pick. (B's gating
  unknown: can the gem user create/delegate a cgroup inside the AIO sandbox?)
- **P1 + P2 ship as ONE change.** Keep the external container sampler as the robust
  always-on baseline AND give it carry-forward (fixes the flicker); add the
  in-sandbox codex-tree reading as the headline with container as fallback/context.

## 6. Method options for P2

| Option | How | Pros | Cons |
|---|---|---|---|
| A `/proc`-walk (exec) | `pgrep -x codex` → sum subtree `/proc/<pid>/stat` (utime+stime Δ → CPU%) + RSS | zero privilege, no launch change, non-invasive | per-tick exec round-trip; needs per-PID prior baseline; sandbox must respond |
| B dedicated cgroup | launch codex in its own cgroup v2 scope; exec-read sub-cgroup `cpu.stat`/`memory.current` | cleanest subtree accounting, cheap reads | changes launch; needs in-container cgroup delegation (UNVERIFIED) |
| C container only (status quo) | docker stats | cheapest, robust even if sandbox wedged | memory misleads (the bug) |
| D hybrid (chosen) | C as baseline (+carry-forward) + A/B as codex headline, fall back to C on miss | accurate + robust fallback | per-task contract gains a `scope` field; two readings |

## 7. Open design points (resolved in design.md)

- carry-forward bound: reuse the prior reading for a still-running but unread task
  for at most N consecutive ticks (then drop / mark unavailable), so a genuinely
  gone container isn't carried forever.
- per-PID CPU baseline: extend the sampler's `previousReadings` to per-process for
  the codex-tree CPU delta.
- process subtree: include codex's descendants (shells it runs, tools, MCP servers).
- PID discovery: `pgrep -x codex` vs the launch-wrapper shell vs tmux pane PID.
- exec cost at 5s cadence × concurrent tasks; bound with `withTimeout`; carry-forward
  covers a missed exec.
- contract: `TaskResourceResponse` gains a `scope: 'process' | 'container'`
  discriminator and carries both the codex-process reading and the container total.
- consider also tuning the per-container `docker stats` timeout / a single retry as
  defense-in-depth for P1.
