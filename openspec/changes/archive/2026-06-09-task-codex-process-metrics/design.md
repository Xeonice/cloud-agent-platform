## Context

See `research-brief.md` for the live ground truth. Summary: the orchestrator
samples sandbox resources from OUTSIDE via `docker stats`/cgroup
(`resource-sampler.service.ts`), which yields only the container aggregate. Two
defects follow:

- **P1 (flicker):** `buildSampledResources` rebuilds the whole snapshot each tick
  from only the containers read that tick; a transient per-container miss (a
  `docker stats` timeout / momentary 404) drops that container, so its
  `GET /tasks/:id/metrics` returns `not-running` for a live task. Single-task is
  masked (all-fail → throw → keep prior snapshot, `:336-346/:400-402`); the flicker
  surfaces with ≥2 concurrent sandboxes. Live-proven: a single quiet task never
  flips.
- **P2 (wrong subject):** the container aggregate is dominated by the AIO sandbox's
  resident services (memory ~1.5 GiB constant regardless of codex). The operator
  wants codex's OWN process monitored. Per-process data is only obtainable from
  INSIDE the sandbox — the sole channel is `POST /v1/shell/exec` (already used for
  clone/auth/prompt/skills). codex runs as a foreground `codex` process in tmux
  (`codex-launch.ts`), so it is `pgrep`-able.

## Goals / Non-Goals

**Goals:**
- A running task's per-task resource read is never reported not-running due to a
  transient single-tick sampling miss (carry-forward).
- The per-task readout's PRIMARY figure is codex's own process subtree
  (CPU + memory), with the container aggregate as background/fallback, honestly
  tagged by `scope`.
- Decide the process-sampling METHOD from real-machine data (spike A vs B) before
  committing the sampler rework.

**Non-Goals:**
- Persisted per-task resource history / time-series (still real-time only).
- Changing the `/metrics` aggregate capacity block, task lifecycle, or guardrails.
- Per-process accounting for anything other than the codex subtree.
- A new in-sandbox resident agent/daemon (we reuse the exec channel).

## Decisions

### D1 — Spike-gated method (Track 1 is a real-machine spike; A vs B)
A throwaway-sandbox spike runs BOTH candidate process-sampling methods and the
sampler rework does not start until one is chosen:
- **A — `/proc`-walk via exec:** `pgrep -x codex` → for codex + its descendants read
  `/proc/<pid>/stat` (utime+stime → CPU% via delta) and RSS (`/proc/<pid>/statm` or
  `status`). Zero privilege, no launch change.
- **B — dedicated cgroup:** launch codex inside its own cgroup v2 scope; exec-read
  the sub-cgroup `cpu.stat`/`memory.current`. Cleaner subtree accounting, cheaper
  reads — but requires a launch change AND in-container cgroup delegation, whose
  feasibility for the unprivileged `gem` user is UNKNOWN and is the spike's primary
  question.
Spike outputs accuracy (vs `docker stats` ground truth), per-tick cost, and B's
feasibility; the chosen method gates D3.

**SPIKE OUTCOME (resolved 2026-06-09, real prod sandbox via codex-driven probe):**
**Method A is chosen; method B is INFEASIBLE.** The probe (codex ran it in a live
`cap-aio` sandbox, gem uid 1000) showed:
- `/sys/fs/cgroup` is mounted **read-only** inside the sandbox — `mkdir
  /sys/fs/cgroup/cxp` → `Read-only file system`; `cgroup.subtree_control` is EMPTY
  (no controllers delegated). So the unprivileged gem user CANNOT create or
  populate a sub-cgroup → **B is out**. (Only a real-machine spike could reveal
  this; the gating unknown is answered NO.)
- Method A is clean: `pgrep -x codex` → a single unambiguous PID; `/proc/<pid>/stat`
  carries utime/stime (CLK_TCK=100) for the CPU delta; `VmRSS` is present
  (≈126 MB for idle codex). nproc=6, cgroup2fs.
- **Quantitative confirmation of the bug:** codex's own RSS ≈**126 MB** vs the
  container aggregate readout ≈**1.5 GiB** — the container overstates codex memory
  ~12×, exactly the misrepresentation this change fixes.
So D3 uses method A (`/proc`-walk via exec); no codex launch change (D2/3.5 cgroup
path is dropped).

### D2 — Carry-forward in the sampler (fixes P1, method-independent)
When a task is still in `runningTaskIds()` but unread on a tick, reuse its most
recent prior reading (tagged stale) for up to N consecutive ticks instead of
omitting it from the rebuilt snapshot. Drop it only when it leaves the running set
or exceeds N. This mirrors the existing "keep prior snapshot on total failure"
philosophy, applied PER-CONTAINER. Lands regardless of the D1 outcome (it protects
both the container reading and the process reading from transient misses).
- *Why bounded:* a container that genuinely vanished (but somehow lingers in the
  running set briefly) must not be carried forever; after N misses it degrades to
  not-sampled.

### D3 — Hybrid reading: codex-process primary + container fallback/background
Per task per tick: take the codex-process reading (method per D1) from inside the
sandbox; ALSO keep the cheap external container reading as the always-on baseline.
Report the process reading as primary (`scope: process`); when the in-sandbox read
is unavailable (sandbox unreachable / exec timeout), report the container reading
(`scope: container`) rather than not-running. Carry-forward (D2) applies to both.
- *Why keep the container path:* it is robust even when the sandbox/exec is wedged,
  and it's the honest fallback; the process path needs a responsive sandbox.

### D4 — Contract: `scope` + dual reading
`TaskResourceResponse` (and the underlying sample shape) in
`packages/contracts/src/metrics.ts` gains a `scope: 'process' | 'container'`
discriminator on the sampled reading and carries codex's process figure plus the
container total. The web readout renders primary-by-scope with the container as
context. `not-running` remains a distinct state for a genuinely not-running task.

### D5 — codex PID discovery + subtree + CPU baseline (for method A)
- PID: `pgrep -x codex` (the foreground binary), distinct from the launch-wrapper
  shell; if multiple match, prefer the one whose cwd is the workspace.
- Subtree: include codex's descendants (the shells it runs tools in, MCP servers)
  by walking `/proc/<pid>/task/*/children` or `ps --ppid` transitively.
- CPU%: per-PID delta of (utime+stime) over wall time between ticks → the sampler's
  `previousReadings` is extended to a per-PROCESS baseline keyed by (taskId, pid).

### D6 — exec cost bounded by the existing timeout pattern
The in-sandbox read reuses the provider's `/v1/shell/exec` + `withTimeout` idiom; a
slow/wedged sandbox times out and falls back (D3) / carries forward (D2). The read
runs at the existing sample cadence (~5s), not per request.

### D7 — Sampler gets per-task sandbox baseUrl via an injected source (mirrors runningTaskIds)
The sampler must address each running task's sandbox to `POST /v1/shell/exec`, but
today it only receives `runningTaskIds()` from the semaphore. We inject a SECOND
read-only source `taskBaseUrl(taskId) → string | undefined`, wired in
`metrics.module` from `GuardrailsService` (which already holds the per-task
`SandboxConnection` via `connectionFor(taskId)` → `connection.baseUrl`) — exactly
the pattern `setRunningTaskIdSource` uses. The metrics module already imports
`GuardrailsService`, so no new module dependency is added; a task with no captured
connection (or `baseUrl` unset) simply yields no process reading and the sampler
falls back to the container scope (D3). The whole codex-process pass is gated by
the same `METRICS_SAMPLING_ENABLED` flag as the existing sampler.

### D8 — codex process-tree exec command (method A, per the spike)
Per running task per tick the sampler execs one bash command that: `pgrep -x codex`
→ recursively collects the codex PID + descendants via `/proc/<pid>/task/<pid>/children`
→ sums utime+stime (CLK_TCK ticks) and VmRSS (kB) across the tree → prints
`OK <ticks> <rssKB> <clkTck>`. The sampler converts ticks→seconds via CLK_TCK and
derives CPU% from the (cpuSeconds, wall) delta against the per-task prior process
reading (a fresh task reports 0% until a baseline exists, like the cgroup path).
`NONE` (no codex process yet) → no process reading this tick (fall back to
container). The command is bounded by `withTimeout`.

## Risks / Trade-offs

- **[Method B may be infeasible]** cgroup delegation inside the AIO sandbox for the
  `gem` user may be blocked. → D1 spike answers this BEFORE committing; A is the
  zero-privilege fallback that always works.
- **[exec-per-tick load]** one exec round-trip per running task per cadence. →
  bounded by `withTimeout`; cadence is ~5s; carry-forward absorbs a missed tick;
  reads are skipped for non-running tasks. Revisit cadence if concurrency is high.
- **[PID/subtree drift]** codex's process tree changes as it spawns/exits tools; a
  mid-read race could under/over-count for one tick. → eventual-consistency is
  acceptable for a sampled metric; carry-forward smooths blips.
- **[Carry-forward masks a real disappearance]** a container that truly died could
  show a stale reading for up to N ticks. → bound N small (e.g. 2–3) so it degrades
  to not-sampled quickly; the task also leaves the running set on real termination,
  which drops it immediately.
- **[Two readings = more contract surface]** the `scope` + dual figure adds fields.
  → additive/optional; the aggregate `/metrics` block is unchanged.

## Migration Plan

1. **Track 1 spike (no production change):** run A and B on a throwaway sandbox;
   record accuracy/cost/feasibility; choose the method. Gate.
2. Contracts: add `scope` + the process/container dual reading (additive).
3. API: carry-forward (D2, ships independently of the method); in-sandbox codex
   sampling (D3/D5 per the chosen method) with container fallback; per-PID baseline.
4. Web: render codex primary + container background by `scope`.
5. Deploy order: contracts → api → web. The aggregate capacity block is unchanged,
   so the dashboard is unaffected.
- **Rollback:** the additive contract fields are optional; reverting the sampler
  restores container-only sampling. No schema/migration involved.

## Open Questions

- N for the carry-forward bound (2–3 ticks?) and whether a carried-forward reading
  should be visually marked stale in the console.
- If method B is chosen: where the codex cgroup scope is created (launch line vs a
  provision step) and how the sub-cgroup path is resolved for the exec read.
- Whether to ALSO raise/retry the per-container `docker stats` timeout as
  defense-in-depth for P1 (independent of carry-forward).
- Whether the dashboard task list should later show a per-task resource column
  (out of scope here; this change only touches the session page readout).
