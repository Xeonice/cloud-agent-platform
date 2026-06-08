# Research brief — console-task-metrics-and-navigation

Side-car provenance. Codebase exploration (2026-06-09), no web research needed.

## #1 per-task resources — already sampled, only exposure+display missing

- `apps/api/src/metrics/resource-sampler.service.ts`: reads running taskIds from the guardrails semaphore and samples EACH `cap-aio-<taskId>` individually via `docker.getContainer(name).stats({stream:false})`. Output `SampledResources.containers[]` — every element already carries `{taskId, cpuPercent, memoryBytes, memoryLimitBytes, memoryPercent}`. (dockerode, post the docker-CLI→dockerode migration.)
- `GET /metrics` (`metrics.controller.ts`) already returns the full `containers[]` + capacity, auth-gated to allowlisted sessions.
- Gap is purely: (a) no per-task read endpoint, (b) `routes/_app/tasks/$taskId.tsx` hard-codes "运行规格未上报", (c) no `taskResourceQuery`. No DB resource table (and none added — real-time only).

## #2 create→navigate — mutation has the id, just doesn't navigate

- `new-task-dialog.tsx` + `tasks/new.tsx`: `createTaskMutation.onSuccess(task)` only `setCreatedTaskId(task.id)` + render `<Link to="/tasks/$taskId">`. `createTask` (real.ts) returns a full `TaskResponse` incl `id`.
- The "re-login" impression is NOT auth — operator confirmed it is just the manual extra click. `_app` `beforeLoad` defers auth to client (SSR-safe) and is not implicated.
- Pre-`running` window is real: a created task is `pending`/`queued`; the sandbox is provisioned only when guardrails admits to `running`. Hence D4's friendly placeholder ships with the navigate.

## Scope

Backend: one per-task metrics route reusing the sampler snapshot (no sampling/DB change). Frontend: one query + detail-page display + pre-running placeholder + onSuccess navigate (two create entry points). All additive.
