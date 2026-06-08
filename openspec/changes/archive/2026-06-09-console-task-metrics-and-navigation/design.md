## Context

Live-verified current state (探针 + 代码):
- `ResourceSamplerService` (`apps/api/src/metrics/resource-sampler.service.ts`) already samples PER CONTAINER: it reads the running taskId set from the guardrails semaphore and, every cadence, calls `docker.getContainer('cap-aio-<taskId>').stats({stream:false})` for each. It produces `SampledResources.containers[]` where every element carries `{taskId, cpuPercent, memoryBytes, memoryLimitBytes, memoryPercent}`, plus `aggregate*` figures.
- `GET /metrics` (`metrics.controller.ts`) already returns the full `containers[]` + capacity, auth-gated to allowlisted sessions.
- Frontend: `capacity-aside.tsx` shows only the global aggregate; `routes/_app/tasks/$taskId.tsx` hard-codes "运行规格未上报" in `contextItems` — it never reads metrics. `queries.ts` has `metricsQuery()` (global) but no per-task query.
- Create flow: `new-task-dialog.tsx` + `tasks/new.tsx` call `createTaskMutation`; `onSuccess(task)` only `setCreatedTaskId(task.id)` and render a `<Link to="/tasks/$taskId">`. `createTask` returns a full `TaskResponse` with `id`. The `_app` route's `beforeLoad` auth gate is NOT the cause of the "re-login" impression — the operator confirmed it is just the manual extra click. A freshly created task is `pending`/`queued`; the sandbox is provisioned only when guardrails admits it to `running`.

## Goals / Non-Goals

**Goals:**
- The session-detail page shows the running task's own CPU/memory, sourced from real samples, degrading honestly when not running.
- Creating a task lands the operator directly in its session, with a friendly placeholder during the pre-`running` window.

**Non-Goals:**
- Resource HISTORY / time-series / persistence (real-time single reading only; a future change can add a `TaskResourceSample` table).
- Changing the sampling layer (already per-task and correct).
- Any auth/session change (the "re-login" impression was the manual click, not an auth defect).
- Preinstall-skills (sibling change `task-preinstall-skills`).

## Decisions

- **D1 — Per-task metrics via a dedicated read, sourced from the existing snapshot.** Add `GET /tasks/:taskId/metrics` (RESTful, lives with task resources) returning that task's `ContainerResourceSample` from `ResourceSamplerService.currentSnapshot().containers.find(c => c.taskId === id)`, or an explicit `{ state: 'not-running' | 'not-sampled' }` when absent. Reuses the snapshot the sampler already maintains; NO new sampling, NO DB. Alternative (`/metrics?taskId=` filter) is equivalent; prefer the path form for a clean per-task resource semantic and so the detail page need not pull the whole global payload. Auth-gated identically to `/metrics` (allowlisted session; 401 otherwise) — per-task resource is still host-execution operational data.
- **D2 — Frontend `taskResourceQuery(taskId)` polls the per-task read.** A focused query (short refetch interval, e.g. same cadence as the sampler) feeds the detail page; on `not-running/not-sampled` the UI shows "未运行/未采样" rather than zeros. Raw bytes/percent stay out of the terminal-bytes path (this is structured JSON via the query cache, unlike the raw PTY stream).
- **D3 — Navigate on create; let the modal unmount.** `onSuccess(task)` calls `useNavigate()({ to: '/tasks/$taskId', params: { taskId: task.id } })`. The dashboard modal closes naturally as the route changes (its host unmounts); the `/tasks/new` page likewise navigates. Keep the existing toast as a transient confirmation. Alternative (keep the link, add nothing) rejected — that is the reported friction.
- **D4 — Session page handles pre-`running` states explicitly.** The page already has a `connection` state machine + fallback line-view. Extend the displayed state so `pending`/`queued` render a friendly "排队中 / 沙箱启动中…" (driven by `taskQuery(taskId).status`), transitioning to the live terminal when status reaches `running`. This makes "create → land in session" graceful instead of dropping onto a "正在连接" blank. The task-status query already exists; this is presentation only.

## Risks / Trade-offs

- **No history** → operators can't see resource trends, only the instantaneous value. Mitigation: documented non-goal; a `TaskResourceSample` table is a clean follow-up if needed.
- **Per-task read races task teardown** → a task that just exited has no container; the endpoint must return `not-running` (not 404-as-error, not stale zeros). Mitigation: D1 explicit state.
- **Navigate-on-create lands before `running`** → handled by D4's placeholder; without D4 it would look broken. The two ship together.
- **Polling cost** → one more lightweight per-task poll while a detail page is open; bounded to the sampler cadence and only while the page is mounted.

## Migration Plan

- Additive; no schema/data migration. Backend per-task route deploys via dokploy; frontend via Vercel (now that the turbo `.vercel/output` cache fix lets every push build + auto-promote).
- Rollback: remove the per-task route + revert the detail-page/query/onSuccess edits; the dashboard aggregate + manual deep link return.

## Open Questions

- Exact refetch cadence for `taskResourceQuery` (match sampler cadence vs. a touch slower) — tune in apply.
- Whether to also surface per-task resource as a small badge in the fleet list (out of scope here; aside already flags high-memory tasks).
