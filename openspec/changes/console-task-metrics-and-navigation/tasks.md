<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: api-per-task-metrics (depends: none)

- [x] 1.1 Add a per-task metrics read in `apps/api/src/metrics/`. — `MetricsService.buildTaskResource(taskId)` filters `ResourceSamplerService.currentSnapshot().containers` for the task; controller route `GET /tasks/:taskId/metrics`. No sampler change, no DB.
- [x] 1.2 Auth-gate the per-task route identically to `/metrics`. — The route is under the GLOBAL `APP_GUARD` (auth.module), NOT in the exemption list, so unauthenticated/de-allowlisted requests are 401'd before the handler runs — same gate as `/metrics`, no per-route code needed.
- [x] 1.3 Add a contract type for the per-task metrics response in `@cap/contracts`. — `TaskResourceResponseSchema`: discriminated union on `state` (`sampled` carries `ContainerResourceSampleSchema` + sampledAt/ageMs; `not-running` carries nothing).
- [x] 1.4 Unit-cover the route. — `metrics/task-resource.test.mjs` drives the real compiled `MetricsService.buildTaskResource`: returns the task's own sample when present; returns `not-running` (not an error, no fabricated zeros) when absent; filters by taskId. 4/4 pass. (401 is the shared global-guard path, covered by the existing auth-guard tests.)

## 2. Track: web-per-task-metrics-display (depends: api-per-task-metrics)

- [x] 2.1 Add `taskResourceQuery(taskId)` in `apps/web/src/lib/api/queries.ts` (+ `real.ts` `getTaskResource` + `mock.ts` `mockTaskResource`) polling the per-task read at the sampler cadence (5s), `queryKeys.taskResource(id)`.
- [x] 2.2 In `routes/_app/tasks/$taskId.tsx`, replaced the hard-coded "运行规格未上报" with a live CPU%/memory readout (`resourceBody` + `formatBytes`) from `taskResourceQuery`, degrading to "未运行 / 未采样" on the `not-running` state (never fabricated zeros).

## 3. Track: web-create-navigation (depends: none)

- [x] 3.1 In `components/dashboard/new-task-dialog.tsx`, `createTaskMutation` `onSuccess(task)` now `useNavigate()({ to: '/tasks/$taskId', params: { taskId: task.id } })` (modal unmounts on navigation); success toast kept.
- [x] 3.2 Mirrored the navigate-on-success in `routes/_app/tasks/new.tsx`.
- [x] 3.3 In `routes/_app/tasks/$taskId.tsx`, a `PreRunningPlaceholder` renders for `pending`/`queued` (from `task.status`) instead of mounting the terminal; it swaps to `SessionTerminal` once the task reaches `running` (tasksQuery polls 5s).

## 4. Track: verify (depends: web-per-task-metrics-display, web-create-navigation)

- [x] 4.1 Static gates GREEN: api + web `tsc` (0), nest build + vite build (0), web vitest (40/40), full api suite (31 files green incl new `metrics/task-resource.test.mjs` 4/4, no regression), eslint on changed api/web/contracts files (0).
- [ ] 4.2 Live (post-deploy): on a running task, the detail page CPU/memory matches `docker stats` for that `cap-aio-<id>`; creating a task lands the console in `/tasks/$taskId` showing queued→running→terminal without a manual click or a blank screen.
