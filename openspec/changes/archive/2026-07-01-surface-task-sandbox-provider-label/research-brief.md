## Research Brief

### Trigger

The live `vibe-zlyan` task `12c791c7-87df-4150-a941-d94bb4374460` was configured and persisted as a BoxLite-backed run, but the session header rendered the sandbox chip as `AIO Sandbox`.

### Evidence

- The live deployment has `CAP_SANDBOX_PROVIDER=boxlite`.
- The task owner row in `sandbox_runs` records `provider_id = boxlite`.
- The remote host showed BoxLite service/shim processes and no AIO sandbox container for that task.
- The session page gets its header context from `taskContextQuery()`.
- `apps/web/src/lib/api/queries.ts` currently hardcodes `runtime: "AIO Sandbox"` for the session tag rail.
- `openspec/specs/frontend-console/spec.md` still describes `AIO Sandbox` as the "truthful sole sandbox provider", which is obsolete after the provider-center refactor.

### Existing Contract Shape

- `packages/contracts/src/task.ts` defines `TaskResponseSchema` as `TaskSchema`.
- `TaskResponse` currently exposes task fields such as `branch`, `strategy`, `runtime`, `executionMode`, guardrails, and delivery result columns.
- `apps/api/src/tasks/tasks.service.ts` funnels task read paths through `toResponse()`.
- `apps/api/prisma/schema.prisma` has `Task.sandboxRuns` and `SandboxRun.providerId`, `providerSandboxId`, `status`, and routing metadata.
- `SandboxProviderRouter` records selected provider ownership after provision through `SandboxRunOwnerStore`.

### Design Constraints

- The frontend must not read provider env or infer provider family from deployment config.
- The global configured provider family is not enough for per-task display; an already-running task must display its selected owner.
- The public task response must not expose `providerSandboxId`, BoxLite endpoint, AIO base/ws URLs, native terminal URLs, auth tokens, or `connectionJson`.
- Unknown or not-yet-provisioned tasks should degrade honestly, not fall back to `AIO Sandbox`.
- The existing "agent runtime" chip (`Codex` / `Claude Code`) is distinct from the sandbox provider chip (`AIO Sandbox` / `BoxLite Sandbox` / future providers).

### Candidate Contract

Add a non-secret `sandboxProvider` field to `TaskResponse`:

```ts
sandboxProvider: {
  id: string;
  label: string;
} | null
```

The `id` comes from the active or most recent task owner record. The `label` is a stable display label derived from the provider id by server/shared contract logic, for example:

- `aio-local` -> `AIO Sandbox`
- `boxlite` -> `BoxLite Sandbox`
- `cloud-http` or unknown ids -> provider-specific/fallback display labels without exposing private data

### Impacted Specs

- `repo-and-task-management`: task read responses should expose the selected sandbox provider summary.
- `frontend-console`: the session header tag rail should render the sandbox chip from `task.sandboxProvider`, not a hardcoded `AIO Sandbox`.
