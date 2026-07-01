## Why

The session header still hardcodes the sandbox chip as `AIO Sandbox`, which is now false for BoxLite-backed tasks after the provider-center refactor. This creates a misleading operator-facing signal: the task may be correctly running on BoxLite while the console claims it is using AIO.

## What Changes

- Add a non-secret sandbox provider summary to task read responses so the console can display the provider selected for that task.
- Derive the summary from the task's persisted provider owner / selected run state, not from frontend constants or deployment env.
- Update the session page tag rail to render the sandbox provider chip from the task response.
- Replace the obsolete frontend assumption that `AIO Sandbox` is the sole truthful provider.
- Preserve provider secrecy: do not expose provider sandbox ids, native terminal URLs, endpoint URLs, auth tokens, connection JSON, or other provider-private routing data.
- Degrade honestly for tasks with no selected sandbox owner yet, rather than guessing `AIO Sandbox`.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `repo-and-task-management`: task read responses expose a non-secret `sandboxProvider` summary derived from the selected sandbox owner when available.
- `frontend-console`: the `/tasks/$taskId` session header renders the sandbox provider chip from `TaskResponse.sandboxProvider` instead of hardcoding `AIO Sandbox`.

## Impact

- Shared contracts: extend `TaskResponseSchema` with an optional nullable sandbox provider summary.
- API: enrich `TasksService` read paths with provider-owner metadata from `sandbox_runs` / `SandboxRunOwnerService` without leaking provider-private connection data.
- Web: update `taskContextQuery()` and session header fallback semantics so AIO and BoxLite tasks display their real sandbox provider.
- Tests: add contract/API/web coverage for BoxLite-backed tasks, AIO-backed tasks, and tasks without a selected provider owner.
- OpenSpec: update stale frontend-console wording that describes AIO as the sole sandbox provider.
