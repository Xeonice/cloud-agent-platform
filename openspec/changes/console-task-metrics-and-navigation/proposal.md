## Why

Two console UX gaps surfaced in live use: (1) a task's session-detail page never shows THAT task's own CPU/memory — the orchestrator already samples per-container resources (every `cap-aio-<taskId>` is sampled individually, each sample carries its `taskId`), but the detail page hard-codes a "运行规格未上报" placeholder and only the dashboard aside shows a global aggregate; (2) after creating a task the operator must manually click an "进入会话" link to reach the session — the create mutation has the new `task.id` in hand but does not navigate, so it feels like an extra step.

## What Changes

- **Expose per-task resources (#1).** Add a per-task metrics read so the session-detail page can show the running task's own CPU% and memory. The sampling layer already produces `SampledResources.containers[]` keyed by `taskId`; this change exposes a single task's slice via a `GET /tasks/:taskId/metrics` (or equivalent `/metrics?taskId=`) endpoint that returns that container's sample (or an explicit "not sampled / not running" state), auth-gated identically to `/metrics`. NO persistence/history — real-time only (a time-series is an explicit non-goal here).
- **Show per-task resources in the session page (#1).** Replace the hard-coded "运行规格未上报" with a live CPU/memory readout driven by a `taskResourceQuery(taskId)`, degrading honestly to "未运行/未采样" when the task has no live container.
- **Navigate to the session on create (#2).** On `createTaskMutation` success, navigate straight to `/tasks/$taskId` (both the dashboard modal and the `/tasks/new` full-page form), instead of only surfacing a deep link. The modal closes as it unmounts on navigation.
- **Friendly early-state placeholder on the session page (#2).** Because a freshly created task is `pending`/`queued` (sandbox not yet provisioned), the session page SHALL show a friendly "排队中 / 沙箱启动中…" state for pre-`running` statuses and transition to the live terminal once it reaches `running`, so "create → land in session" never drops the operator onto a blank/confusing screen. This is NOT an auth issue (the "re-login" impression was just the manual extra click).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `resource-metrics`: the **Aggregation endpoint** requirement gains a per-task resource read (a `GET /tasks/:taskId/metrics` slice / `?taskId=` filter returning a single container's sampled CPU/memory or an explicit not-running/not-sampled state), auth-gated like `/metrics`, real-time only (no persistence).
- `frontend-console`: the **Session page** requirement gains a live per-task CPU/memory readout (replacing the hard-coded placeholder) and a friendly pre-`running` placeholder; the **New task creation** requirement changes from "surface a deep link" to "navigate directly into `/tasks/$taskId` on success".

## Impact

- **Code (api):** a per-task metrics route (`apps/api/src/metrics/*` controller/service — reuses `ResourceSamplerService.currentSnapshot()` + filters `containers[]` by taskId; no sampler change), auth-gated like the existing `/metrics`.
- **Code (web):** `lib/api/queries.ts` (+`real.ts`) new `taskResourceQuery(taskId)`; `routes/_app/tasks/$taskId.tsx` (render live CPU/memory + friendly pre-running placeholder); `components/dashboard/new-task-dialog.tsx` + `routes/_app/tasks/new.tsx` (`onSuccess` → `useNavigate()` to the session).
- **No DB change, no sampler change.** Sampling is already per-task; this is exposure + display + a navigate call.
- **Specs:** `openspec/specs/resource-metrics/spec.md` (MODIFIED delta) + `openspec/specs/frontend-console/spec.md` (MODIFIED delta).
- **Live verification:** open a running task's detail page and confirm its CPU/memory match `docker stats` for that `cap-aio-<id>`; create a task and confirm the console lands in `/tasks/$taskId` showing the queued→running transition.
