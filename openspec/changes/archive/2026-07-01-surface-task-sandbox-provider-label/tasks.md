<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: contracts-provider-summary (depends: none)

- [x] 1.1 Add a public `TaskSandboxProviderSchema` / type with `id` and `label` string fields, plus a nullable `sandboxProvider` field on `TaskResponseSchema`.
- [x] 1.2 Ensure `ListTasksResponseSchema` uses the enriched `TaskResponseSchema` so single-task and list responses share the same public shape.
- [x] 1.3 Add contract tests for BoxLite, AIO, null/no-owner, and unknown-provider summaries, including assertions that provider-private fields are not part of the schema.

## 2. Track: api-task-response-enrichment (depends: contracts-provider-summary)

- [x] 2.1 Add a server-side helper that maps persisted sandbox provider ids to public display labels without exposing provider connection metadata.
- [x] 2.2 Extend `TasksService` read queries/mapping so create, list, fetch-by-id, and transition/stop responses include `sandboxProvider` from the latest relevant `sandbox_runs` row.
- [x] 2.3 Keep task list enrichment batched or query-level so listing tasks does not perform one sandbox-run lookup per row.
- [x] 2.4 Add API tests covering BoxLite-backed, AIO-backed, and no-owner tasks, with negative assertions for `providerSandboxId`, `connectionJson`, endpoints, native URLs, tokens, and metadata.

## 3. Track: web-session-provider-chip (depends: contracts-provider-summary)

- [x] 3.1 Rename the session context field used for the sandbox chip away from `runtime` to a clear `sandboxProviderLabel` / `sandboxLabel` name.
- [x] 3.2 Update `taskContextQuery()` to populate the sandbox chip from `task.sandboxProvider?.label`, using an honest pending/unassigned fallback when the field is null or absent.
- [x] 3.3 Remove frontend comments, mocks, and route fallbacks that describe or assume `AIO Sandbox` as the sole provider.
- [x] 3.4 Add web coverage showing a BoxLite task renders `BoxLite Sandbox`, an AIO task renders `AIO Sandbox`, and an unselected task does not guess AIO.

## 4. Track: verification (depends: api-task-response-enrichment, web-session-provider-chip)

- [x] 4.1 Run focused contract tests for task response parsing.
- [x] 4.2 Run focused API tests for task response mapping and sandbox-run owner projection.
- [x] 4.3 Run focused web tests for the session header/task context chip.
- [x] 4.4 Run `rg` checks to confirm no production frontend code still hardcodes the provider chip as `AIO Sandbox`.
- [x] 4.5 Run `openspec validate surface-task-sandbox-provider-label --strict`.
