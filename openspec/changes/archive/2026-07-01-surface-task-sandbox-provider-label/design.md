## Context

The console session header currently renders the sandbox chip from frontend-only context data and hardcodes it as `AIO Sandbox`. That was acceptable when AIO was the only provider, but it is false after the provider-center split: a task can be selected, owned, and reattached by BoxLite while the UI still claims AIO.

The backend already persists provider ownership in `sandbox_runs` through `SandboxRunOwnerService`. That persistence contains both safe fields (`providerId`, status timestamps) and provider-private routing data (`providerSandboxId`, `connectionJson`, metadata). The frontend needs a small display summary, not direct access to those internals.

## Goals / Non-Goals

**Goals:**

- Make the `/tasks/$taskId` session header display the task's selected sandbox provider from backend data.
- Add a public, non-secret `sandboxProvider` summary to task read responses.
- Keep the agent runtime chip (`Codex` / `Claude Code`) separate from the sandbox provider chip (`AIO Sandbox` / `BoxLite Sandbox` / future providers).
- Preserve the API boundary: web code consumes `TaskResponse`, not sandbox package types, provider env, native endpoints, or connection metadata.
- Degrade honestly before a sandbox owner exists.

**Non-Goals:**

- Changing sandbox scheduling, provider selection, reattach, terminal transport, or lifecycle behavior.
- Exposing native provider identifiers beyond the public provider id and display label.
- Adding a provider picker or changing `CAP_SANDBOX_PROVIDER` configuration semantics.
- Reworking the session page layout beyond the provider chip data source.

## Decisions

1. **Expose a public `sandboxProvider` summary on `TaskResponse`.**

   `TaskResponse` will include:

   ```ts
   sandboxProvider: {
     id: string;
     label: string;
   } | null
   ```

   This keeps the UI contract explicit and testable. The field is nullable so queued tasks, tasks that failed before provisioning, and old rows with no owner can render a truthful pending/unassigned state.

   Alternative considered: keep the field frontend-only and infer from env or capability flags. That is incorrect for per-task display because provider selection is task-scoped once an owner is recorded, and env only describes candidate configuration.

2. **Derive the summary from persisted sandbox ownership, not provider internals.**

   API task read paths will look up the newest relevant `SandboxRun` row for the task and project only `providerId` into the response summary. For active tasks, this corresponds to the selected owner. For terminal or removed tasks, retaining the most recent provider id is useful for historical display, but the response still must not expose `providerSandboxId`, `connectionJson`, endpoint URLs, auth tokens, native terminal URLs, or provider metadata.

   Alternative considered: call `SandboxProvider.getSelectedSandboxRun()` from the task response mapper. That would couple task reads to live provider availability and would pull provider-center behavior into simple REST reads. The persisted owner row is the stable source for a display label.

3. **Centralize provider display labels in shared/server-side mapping.**

   The public label should be derived by a small helper, for example:

   - `aio-local` / `aio` -> `AIO Sandbox`
   - `boxlite` / `boxlite-*` -> `BoxLite Sandbox`
   - `cloud-http` / `cloud-*` -> `Cloud Sandbox`
   - unknown ids -> a neutral provider label that includes no endpoint or native routing data

   This helper can live in contracts if both API tests and web tests need the exact mapping, or in API with the computed `label` carried over the contract. The key constraint is that the frontend does not maintain a parallel provider-family inference table for task headers.

   Alternative considered: expose only `providerId` and let the web label it. That recreates drift risk and would spread provider semantics into UI code.

4. **Update task read queries without introducing N+1 behavior.**

   `TasksService` should enrich create/fetch/list/transition responses through one mapper path. List reads should select/include the latest sandbox run per task in the Prisma query where practical, or fetch a bounded map for the returned task ids and pass the summary into `toResponse()`. The response shape remains additive and backward-compatible.

   Alternative considered: only fix `GET /tasks/:id` because the current bug is on the session page. That would leave history/list consumers unable to use the same safe field later and would break the "every task read path echoes task metadata" pattern already used for runtime, execution mode, delivery, and guardrails.

5. **Rename the frontend context field away from `runtime` for the sandbox chip.**

   `TaskContextView.runtime` currently means "sandbox chip" while `task.runtime` means "agent runtime". The implementation should introduce a clearer `sandboxProviderLabel` / `sandboxLabel` context field and update the session tag rail to use it. Existing mocks can still provide AIO/BoxLite examples, but real data must come from `task.sandboxProvider?.label`.

   Alternative considered: keep the `runtime` property and change only its value. That preserves the confusing naming that helped hide the bug.

## Risks / Trade-offs

- **[Risk] Task list enrichment can add extra DB work.** -> Mitigate by selecting the latest sandbox run with the task query or batching by task ids instead of per-row reads.
- **[Risk] The response could accidentally leak provider-private routing data.** -> Mitigate with an allowlist projection (`id`, `label`) and contract/API tests that assert excluded fields are absent.
- **[Risk] Historical terminal tasks may have `removed` owner rows.** -> Mitigate by allowing the display summary to use the latest run row regardless of active status while reserving active-only owner lookup for lifecycle operations.
- **[Risk] Unknown future providers may render awkward labels.** -> Mitigate with a neutral fallback and tests that unknown ids do not expose URLs or metadata.
- **[Risk] Existing web mocks and tests may still assert `AIO Sandbox`.** -> Mitigate by updating mock task responses and adding BoxLite-specific header coverage.

## Migration Plan

1. Extend `@cap/contracts` with `TaskSandboxProviderSchema` and `TaskResponseSchema = TaskSchema.extend({ sandboxProvider: ... })`; update list responses to use `TaskResponseSchema`.
2. Update API task response mapping to attach a nullable sandbox provider summary from `sandbox_runs`.
3. Update web API/task context typing and session header rendering to use `task.sandboxProvider?.label`, with an honest pending/unassigned fallback.
4. Update stale `frontend-console` spec text and tests that treated AIO as the sole provider.
5. Verify with focused contract/API/web tests and `openspec validate surface-task-sandbox-provider-label --strict`.

Rollback is low risk because the field is additive: the UI can fall back to its pending label if the field is absent during a mixed deploy, but it must not fall back to `AIO Sandbox`.
