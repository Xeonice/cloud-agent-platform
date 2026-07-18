## Incident evidence

The `vibe-zlyan` task `cc35e0c1-0597-461a-be85-b136930924bc` exposed a
diagnostic blind spot rather than a complete absence of logging. The API request
remained open while the legacy admission path synchronously provisioned a
BoxLite sandbox. The repository transfer and checkout completed, runtime files
were written, provisioning then failed, and cleanup also failed. The surviving
records can narrow the failure to the composite `runtime_setup` boundary, but
they cannot distinguish a non-zero setup command, a native execution poll or
attach failure, an indeterminate settlement, or a cleanup error that replaced
the primary failure.

The deployed admission-v2 gate was closed, so this task did not receive a
`task_admission_work` row, durable stage/attempt/cause checkpoints, or a
persisted `sandbox_runs` owner. The existing admission-v2 implementation would
improve the evidence to `runtime_setup + provisioning_unknown`, but would still
discard the provider-native safe cause before it becomes queryable.

## Current implementation map

- `apps/api/src/observability/logger.options.ts` provides Pino JSON stdout,
  request ids, task-local correlation, and key-based secret redaction.
- `openspec/specs/observability/spec.md` covers transport, retention,
  aggregation, query, visualization, and alerting. It does not define a
  provisioning-operation event vocabulary or require safe provider settlement
  facts.
- `apps/api/src/guardrails/guardrails.service.ts` records only a fixed
  `provider details redacted` message on the legacy provider catch and falls
  back to `provision_failed` for ordinary provider stage failures.
- `apps/api/src/task-admission/*` and `TaskAdmissionWork` persist safe stages,
  attempts, and terminal causes for admission-v2, but the worker does not own a
  provider-operation diagnostic context and runtime setup stage errors still
  classify as `provisioning_unknown`.
- `packages/sandbox/src/host-harness/configured-provider.ts` temporarily has a
  setup command's exit code and scrubbed output. The BoxLite provider replaces
  ordinary setup errors with `SandboxProvisioningStageError`, intentionally
  dropping the underlying diagnostic before orchestration can record a safe
  classification.
- `packages/sandbox-provider-boxlite/src/boxlite-client.ts` has no diagnostic
  observer. Attach errors are best-effort and silent, poll settlement does not
  emit an operation record, and terminal `failed`/`killed` without an exit code
  currently risks normalizing to exit code zero.
- BoxLite provisioning cleanup is awaited before the primary error is rethrown;
  a cleanup rejection can therefore replace the original failure.
- Canonical task reads shared by Console, Public V1, and MCP expose only safe
  admission-v2 progress and terminal task failure. There is no task diagnostics
  operation/tool, cleanup projection, or provider execution history.
- Existing metrics cover capacity, occupancy, runner minutes, CPU, and memory,
  but not provisioning duration, safe failure class, retry, cleanup failure,
  orphan count, or native execution settlement anomalies.

## Prior-change boundary

The archived `2026-07-16-fix-large-repo-task-provisioning` change already owns
durable acceptance, asynchronous admission, safe progress, stable public
failure categories, and Public V1/MCP task projection parity. Its rollout
deliberately ships with admission-v2 closed until deployment attestation passes,
and its non-goals exclude raw Git output, authenticated commands, tokens,
provider connection details, and diagnostic output from ordinary task
responses. This proposal must extend that design rather than reopen or bypass
its acceptance path.

## Security and product constraints

- Never record command text, repository-authenticated URLs, request/response
  bodies, headers, tokens, credential paths, stdout/stderr, prompts, environment
  dumps, lease owners, or native connection URLs.
- Runtime setup commands need an explicit allowlisted `commandKind`; their shell
  text cannot be logged or reverse-parsed because it may contain encoded
  credentials and prompts.
- Provider diagnostics must be a versioned strict discriminated union with
  bounded strings and numeric facts, not an arbitrary JSON diagnostic bag.
- Public task reads remain stable and secret-free. Deeper diagnostics require a
  dedicated scope and owner/admin authorization, with one canonical schema for
  REST and MCP.
- A task-level diagnostic-version marker must distinguish a new task that has
  not reached a processing attempt from a historical task that predates the
  ledger; missing or interrupted writes must never be reported as complete.
- Diagnostic persistence must work in both legacy and admission-v2 modes so the
  current rollout state is diagnosable, while automatic orphan ownership and
  recovery continue to rely on admission-v2's fenced `SandboxRun` model.
- Operation events are bounded: record start and one terminal/degraded summary,
  not every BoxLite poll tick or output frame.

## Recommended architecture

1. Add a provider-neutral provisioning diagnostic context and emitter in
   sandbox-core. The API records a task-level coverage expectation and creates
   one attempt identity only when an actual processing attempt starts; providers
   add only validated operation facts. Accepted/unclaimed and capacity-queued
   durable work continues to report its existing safe admission state without a
   fabricated provider attempt.
2. Persist a task-owned attempt summary and immutable, idempotent, bounded
   operation-event detail. Normal writes are append-only; a controlled
   transaction may compact only old cleanup-settled attempts into a typed bounded
   overflow summary. Mirror the same safe envelope to structured stdout.
3. Instrument the AIO, cloud-http, and BoxLite provider families. For BoxLite,
   cover create/start/inspect, workspace materialization,
   preflight, runtime setup command execution, native exec start/poll/attach/
   settlement, and cleanup confirmation. Preserve primary and secondary cleanup
   failures independently, including provider-center fallback cleanup as a
   later cleanup attempt in the same cleanup lineage.
4. Treat a terminal native `failed` or `killed` state without an exit code as an
   unresolved failure, never success. Attach degradation may remain non-fatal
   when polling proves settlement, but it remains observable.
5. Add an owner-required and `tasks:diagnostics`-scoped canonical diagnostics read:
   `GET /v1/tasks/{id}/provisioning-diagnostics` and MCP
   `get_task_provisioning_diagnostics`, plus the session-authenticated Console
   route. Public V1/MCP require an authenticated account owner; identity-less
   legacy principals fail closed, and only the session-authenticated internal
   Console route may perform a live-verified administrator cross-owner read.
   Keep ordinary task schemas unchanged.
6. Add low-cardinality metrics for stage/operation duration, outcomes, retries,
   cleanup failures, oldest active attempt, orphan runs, and settlement
   anomalies. Do not label metrics with task, sandbox, execution, or URL ids.
7. Retain lifecycle audit as the permanent product timeline and do not duplicate
   every diagnostic event into `audit_events`.

## Verification focus

- Unit and conformance fault injection for create/start, missing exit code,
  non-zero exit, attach error, invalid poll response, poll timeout, transport
  failure, runtime setup failure, cancellation, and cleanup failure.
- Assert primary failure survival when cleanup also fails.
- Secret-canary scans across structured logs, persisted attempts/events, audit,
  REST, MCP, OpenAPI examples, and metrics.
- Cross-surface schema and authorization parity for Public V1, MCP, OpenAPI, API
  Playground, and Console owner/admin reads.
- Legacy-mode and admission-v2 end-to-end cases, including request disconnect,
  API restart, a slow large private Gitee clone, and orphan reconciliation.
