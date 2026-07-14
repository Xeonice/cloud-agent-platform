## Why

CAP allows callers to choose `codex` or `claude-code` for a task, but it cannot
choose the model used by that concrete run. A static console-only picker would
drift from the CLI version, credential, policy, and sandbox environment that
actually execute the task, while Public V1 and MCP callers would have no
supported way to discover valid values.

## What Changes

- Add an optional requested `model` to the canonical task-create contract and
  carry it through one-off tasks, recurring task templates, persistence, task
  reads, recovery, admission, and both interactive and headless runtime launch.
- Keep the persisted requested selector distinct from the runtime-reported
  actual model so aliases, defaults, substitutions, and failures are reported
  honestly instead of rewriting task intent.
- Add an owner-, runtime-, credential-, and sandbox-environment-aware model
  catalog. The catalog is resolved against the effective CLI/toolchain and
  reports its source, completeness, revision, default when known, and safe
  ordered model metadata.
- Expose the same catalog contract through
  `POST /v1/runtime-models/query`, MCP `list_runtime_models`, the API
  Playground, and the console task-creation surfaces. Dynamic model ids remain
  bounded strings rather than a static OpenAPI/MCP enum.
- Validate a requested model before creating or admitting a task. Scheduled
  task create/update performs an initial validation and each future fire
  revalidates against its then-current execution context. An unavailable model
  fails that occurrence, while a transient catalog outage receives bounded
  retry; pre-task stages create neither a Task row nor a task-owned execution
  sandbox, and any catalog probe resource is always reclaimed.
- Add contract, persistence, launch, API/MCP parity, scheduling, recovery,
  security, cache, and end-to-end verification for both runtimes and for model
  catalog changes over time.
- Ship explicit model selection behind a default-closed, server-side deployment
  capability gate plus a mandatory first-release write-maintenance cutover.
  Before model-aware clients are reachable, close write ingress/MCP and remove
  every N-1 API/admission/scheduler/runtime worker, because an old schema can
  strip unknown `model` fields. Open all surfaces only after N capability
  verification; rollback closes admission first and drains explicit-model work
  before any capable worker is removed.
- Preserve existing behavior when `model` is omitted. All wire changes are
  additive; this change introduces no breaking API removal or rename.

## Capabilities

### New Capabilities

- `runtime-model-catalog`: Resolve and validate the models available to the
  authenticated owner for an effective runtime, credential, sandbox
  environment, and CLI version without exposing secrets.

### Modified Capabilities

- `repo-and-task-management`: Tasks accept, persist, and return an optional
  requested model across every create and read path.
- `agent-runtime`: Runtime launch policy safely applies a validated per-task
  model and preserves it through launch and recovery without claiming it is the
  runtime-reported actual model.
- `frontend-console`: One-off and recurring task creation offer a catalog-backed
  model selector whose choices follow runtime and environment context.
- `public-v1-api`: Public V1 exposes model selection plus a scoped catalog
  query and stable model-validation error contracts.
- `mcp-server`: MCP exposes the same create field, model catalog, validation,
  response, and structured error semantics as Public V1.
- `scheduled-tasks`: Schedule templates persist and revalidate requested models
  and record catalog/model failures before task creation.
- `api-playground`: The curated API catalog documents and executes model-aware
  task and schedule requests and the runtime-model catalog operation.

## Impact

This affects shared Zod contracts and the public operation manifest, the Prisma
task model and migration, task/schedule services and recovery, runtime launch
ports and Codex/Claude adapters, sandbox-environment and credential resolution,
bounded catalog caching, task-create console forms, OpenAPI/API Playground,
MCP tool registration and error mapping, and cross-surface verification. The
catalog implementation must follow the CLI versions packaged by each effective
sandbox environment; it must not depend on the API host's local CLI or expose
credential/provider internals.
