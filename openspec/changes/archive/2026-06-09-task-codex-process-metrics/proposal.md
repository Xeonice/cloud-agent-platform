## Why

The per-task sandbox resource readout has two real defects, confirmed by live
probing of production (see `research-brief.md`):

1. **It can flip a live, running task to `未运行/未采样`.** The background CPU/memory
   sampler rebuilds its whole snapshot each tick from only the containers it read
   THAT tick; a single transient per-container read miss (a `docker stats` timeout
   or a momentary 404) silently drops that container — so its `GET /tasks/:id/metrics`
   returns `not-running` even though the task is running and its sandbox is alive.
   (Single-task is masked because an all-fail tick throws and keeps the prior
   snapshot; the flicker surfaces with ≥2 concurrent sandboxes — the ones the
   operator is not actively in.)
2. **It measures the whole CONTAINER, not codex.** Sampling is done from OUTSIDE via
   `docker stats`/cgroup, which only yields the container aggregate (the AIO sandbox's
   own services — HTTP server, tmux, node — plus codex). Live data shows memory is
   ~constant ~1.5 GiB regardless of codex activity (dominated by the sandbox baseline),
   so the readout misrepresents "codex's own usage" — the operator wants the launched
   process monitored, not the container.

## What Changes

- **Sampler carry-forward (fixes the flicker).** When a task is still in the running
  set but its container was not readable on a given tick, the sampler SHALL reuse its
  most recent prior reading (bounded to N consecutive carry-forwards) instead of
  dropping it from the rebuilt snapshot — so a transient per-container read miss never
  flips a live task to `not-running`. The container is only dropped when it actually
  leaves the running set or stays unreadable past the bound.
- **codex process-tree sampling (primary) + container (background).** Add an
  in-sandbox reading of codex's own process subtree (CPU + RSS), taken via the
  existing `POST /v1/shell/exec` channel, reported as the PRIMARY per-task figure;
  the external container aggregate is retained as the robust always-on baseline,
  shown as background context and used as the fallback when the in-sandbox read is
  unavailable.
- **Measurement method is spike-gated.** A real-machine spike (Track 1) runs BOTH
  candidate methods — A: `/proc`-walk of the codex subtree via exec; B: a dedicated
  cgroup v2 scope for codex read via exec — compares accuracy/cost/feasibility (incl.
  whether the unprivileged `gem` user can create/delegate a cgroup inside the AIO
  sandbox), and the chosen method gates the sampler implementation.
- **Per-task resource contract gains a `scope`.** `TaskResourceResponse` carries a
  `scope: 'process' | 'container'` discriminator (honest about which reading is shown)
  alongside the codex-process figure and the container total, so the console never
  misrepresents a container aggregate as the process's usage.
- **Console readout** shows codex's own CPU/memory as the headline with the container
  total as secondary/background context, labeled by `scope`.

## Capabilities

### New Capabilities

None — both are existing capabilities.

### Modified Capabilities

- `resource-metrics`: the per-task sampled reading is sourced primarily from codex's
  own process subtree (sampled in-sandbox), not only the container aggregate, and
  carries a `scope`; the sampler carries forward a prior reading for a still-running
  task it could not read on a tick (bounded) rather than dropping it, so a transient
  read miss never reports a running task as not-running.
- `frontend-console`: the session page per-task resource readout shows codex's own
  CPU/memory as the primary figure with the container total as background context,
  honestly labeled by the reading's `scope`.

## Impact

- **Contracts** (`packages/contracts/src/metrics.ts`): `TaskResourceResponse` /
  `ContainerResourceSample` gain a `scope` + the dual (process + container) reading.
- **API** (`apps/api/src/metrics/resource-sampler.service.ts`,
  `metrics.service.ts`): per-task carry-forward; per-PID prior baseline for the
  codex-tree CPU delta; in-sandbox codex sampling via `/v1/shell/exec` (method per
  the spike), with container fallback. Possibly a small launch change
  (`terminal/codex-launch.ts` / provider) IF method B (cgroup) is chosen.
- **Web** (`apps/web/src/routes/_app/tasks/$taskId.tsx`, queries): render codex
  primary + container background per `scope`.
- **Spike**: a throwaway-sandbox real-machine spike (A vs B) gates the design — no
  production change until the method is chosen.
- **Tests**: sampler carry-forward (a still-running unread task stays sampled);
  codex-tree CPU/RSS aggregation (pure); contract `scope` round-trip; web readout.
- **No behavior change** to task lifecycle, guardrails, or the `/metrics` aggregate
  capacity block.
