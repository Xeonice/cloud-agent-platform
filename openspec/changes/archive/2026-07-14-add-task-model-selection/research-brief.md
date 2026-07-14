## Research Brief

### Problem Statement

CAP can select the task runtime (`codex` or `claude-code`) before admission, but
cannot select a model for one concrete task. Model defaults currently live at
credential/CLI configuration level, so two tasks owned by the same account
cannot deliberately choose different supported models. Adding a web-only text
field or static picker would be unsafe: the selected value could drift from the
CLI version baked into the chosen sandbox environment, and machine callers
would again be able to submit a value without any public way to discover the
valid choices.

The feature therefore needs two related capabilities:

1. a durable optional requested-model selector carried by every task creation
   path into the runtime launch; and
2. an owner-, runtime-, credential-, and environment-aware model catalog shared
   by the console, Public V1 API, API Playground, and MCP.

### Current Task Contract and Execution Flow

`CreateTaskRequestSchema` is the canonical task-create body. It currently
contains `prompt`, `branch`, `strategy`, `skills`, `deadlineMs`,
`idleTimeoutMs`, `runtime`, `sandboxEnvironmentId`, and `deliver`.

The important propagation seams are already shared:

- Console REST validates `CreateTaskRequestSchema` and passes the complete body
  to `TasksService`.
- `V1CreateTaskRequestSchema` extends the same schema with `repoId`.
- MCP `create_task` advertises and parses the V1 schema rather than maintaining
  a second task field list.
- `ScheduleTaskTemplateSchema` and schedule create templates extend the same
  task-create schema.
- `TasksService.createTaskRow` manually persists each task field;
  `taskResponseFromRecord` manually projects the canonical response.
- Schedule startup recovery reconstructs a create body from a persisted task,
  so a new field must be added there as well as to normal create.
- `AgentRuntime` owns runtime-specific launch policy while the sandbox/provider
  mechanism stays runtime-agnostic. Both Codex and Claude implement interactive
  and headless launch builders.

Adding `model` only to the shared input schema would make it visible to Console,
V1, MCP, and schedule templates, but would not persist it, pass it through the
runtime port, add `--model`, or retain it during schedule recovery. Conversely,
adding it only to the web payload today would have no effect because the Zod
object strips undeclared fields.

### Requested Model Versus Actual Model

The task field should represent the requested selector exactly as supplied by
the caller. It may be a stable model id or a CLI-supported alias. Omission means
"use the effective CLI/account default" and must remain distinguishable from a
named selector.

The actual model must not be fabricated from that request. Session-history
metadata already has a `meta.model` field populated from runtime transcript
records. The product should therefore use:

- `Task.model`: requested selector, nullable when the caller chose the default;
- `SessionHistory.meta.model`: runtime-reported actual model when available.

If a provider or CLI substitutes/falls back to another model, the requested and
actual values remain different and the UI/API can report the substitution
honestly.

### CLI Capability Reality

The sandbox images, not the API host or developer workstation, are the runtime
source of truth. Both current AIO and BoxLite images pin Codex `0.144.1` and
Claude Code `2.1.207`, and sandbox-environment validation already retains the
builder-declared CLI versions and resolved image metadata.

#### Codex

Codex accepts `--model` for interactive and `codex exec` launches. The pinned
App Server protocol exposes `model/list`, returning structured model ids,
display names, default status, input modalities, and supported reasoning
efforts. CAP already has a bounded, runtime-validated `CodexAppServerClient` and
a checked App Server schema fixture tied to the pinned Codex version for device
login. Extending that client and fixture with `model/list` is safer than parsing
TUI output or duplicating a frontend list.

For an official credential, the catalog should come from the effective Codex
App Server running in the selected sandbox image with the task owner's
credential/configuration. For a saved OpenAI-compatible provider, the existing
bounded provider model-discovery client can supply the provider ids, while the
pinned Codex capability still gates whether that provider mode is runnable.

Primary source:
https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md

#### Claude Code

Claude Code accepts `--model <alias|name>` and supports effective restrictions
through `availableModels`, provider-specific model mappings, and optional LLM
gateway `/v1/models` discovery. The installed/pinned CLI does not expose a
general non-interactive `models` command equivalent to Codex `model/list`; the
ordinary `/model` picker is interactive and must not be scraped.

An execution-ready gateway could eventually use its documented `/v1/models`
endpoint as an authoritative source, but CAP does not currently implement that
Claude execution path. The first version should therefore expose only a
version-checked, documented alias/model subset that the pinned subscription CLI
accepts and label completeness honestly rather than claiming the complete
account entitlement list. Every advertised selector needs gated launch evidence
for each unique packaged Claude CLI artifact checksum; shared checksums may
deduplicate the selector matrix, while AIO and BoxLite still receive a
representative provider-seam smoke. Task creation still revalidates against the
current catalog and fails closed when a requested selector is no longer usable.

The current Claude runtime resolves only subscription OAuth material and does so
through an unscoped first matching credential rather than a task-owner lookup.
The settings layer can store `api_key` mode and `defaultModel`, but API-key
injection and default-model launch wiring are explicitly deferred in
`PrismaClaudeAuthSource`. Catalog and launch must owner-scope the supported
subscription path, and this change must not advertise API-key mode or an inert
stored default as execution-ready unless it also closes those runtime gaps.

Primary sources:

- https://code.claude.com/docs/en/model-config
- https://code.claude.com/docs/en/cli-usage
- https://code.claude.com/docs/en/llm-gateway

### Public API and MCP Parity Audit

The current public data manifest contains 17 operations; 16 map to MCP tools and
task lifecycle SSE is the sole explicit REST-only exclusion. MCP task creation
now reuses the V1 schema and has a full-field forwarding test, so task input
wire parity is substantially better than in earlier changes.

Discovery parity is not complete:

- Runtime readiness is exposed only by unversioned `GET /runtimes`; it has no
  Public V1 operation or MCP tool.
- The shared readiness contract declares a bare array while the service returns
  `{ runtimes: [...] }`; the web client tolerates both shapes.
- `sandboxEnvironmentId` is accepted by V1/MCP, but environment listing is only
  available through unversioned REST.
- `skills` is accepted by V1/MCP, but its selectable catalog is web/static only.
- Schedule MCP task templates inherit task fields, but the outer create/update
  input shapes are manually copied. The SDK strips undeclared fields before the
  callback, so future outer fields can disappear before canonical parsing.
- REST/Nest domain exceptions do not automatically become stable structured MCP
  errors; model errors require an explicit transport-neutral mapping.

The model feature must not repeat this pattern. It needs a canonical public
catalog operation mapped to an MCP tool and consumed by the console.

### Recommended Contract and Service Boundary

Create a new `runtime-model-catalog` capability with shared request/response
schemas and one `RuntimeModelCatalogService`:

```text
runtime/environment/owner resolution
  -> RuntimeModelCatalogService
       -> Codex catalog adapter
       -> Claude catalog adapter
       -> bounded cache
  -> Console / Public V1 / MCP
```

Use a JSON body so environment selection preserves the same three states as
task creation:

```text
POST /v1/runtime-models/query
MCP  list_runtime_models

{
  runtime: "codex" | "claude-code",
  sandboxEnvironmentId?: UUID | null
}
```

- omitted environment: resolve the owner's managed default;
- explicit `null`: bypass the owner default and use deployment fallback;
- UUID: resolve that exact ready, compatible environment.

The response should contain the runtime, a discriminated effective environment
(`managed` with id or `deployment-default` with null id), an opaque execution
fingerprint, effective CLI version, catalog source and completeness, a revision,
default model when known, and ordered model items. It must never return
credentials, provider response bodies, internal endpoints, or raw CLI stderr.
Catalog probing and Task provisioning must share one resolved immutable
provider digest/checksum plus validated metadata and CLI version. The Task
persists that non-secret snapshot so a mutable image tag or deployment default
cannot retarget launch after preflight; explicit selection fails closed when no
immutable provider identity can be established.

The public operation should require `tasks:write`, because a key authorized only
to create tasks must be able to perform creation preflight. Owner identity comes
from the REST/MCP principal, never from a client-supplied user id. The operation
must be added to `PUBLIC_V1_OPERATIONS` with an explicit
`list_runtime_models` MCP mapping so controllers, OpenAPI, API Playground, and
tool inventory remain synchronized.

Do not encode dynamic models as a static enum in `create_task` JSON Schema. The
task field remains a bounded string and `RuntimeModelCatalogService` validates
it using current owner/runtime/environment context.

### Persistence and Launch Implications

- Add a nullable `Task.model` column and migration.
- Persist the non-secret immutable execution-environment snapshot used by
  catalog validation and reuse it for provisioning and recovery.
- Add optional `model` to create contracts and nullable model to task reads.
- Persist and project it on every create/get/list/stop response path.
- Include it in schedule templates and recovery body reconstruction.
- Thread it through `ProvisionLookup`/runtime launch context without adding
  runtime identity branches to shared sandbox mechanisms.
- Carry a discriminated runtime-default/explicit intent through every launch
  context; lookup or selector-file failure must fail closed rather than becoming
  a default-model launch.
- Codex and Claude add `--model` only for a new interactive/headless session
  when a selector is present. Because current launches are nested in shell and
  tmux quoting, raw selector text should travel through the existing bounded
  base64/file setup-material seam and be read as one double-quoted argument;
  omission preserves current launch bytes and default behavior.
- Resume paths retain the session's original model unless a separately specified
  product behavior explicitly permits changing it.
- Compatible Codex provider configuration may still carry its account default;
  an explicit task `--model` is the per-run override after catalog validation.

Model ids may legitimately contain punctuation such as slash, colon, dot,
hyphen, brackets, or provider-qualified names. Validation should reject empty,
oversized, control-character, and null-byte values rather than enforcing an
overly narrow alphanumeric regex. The launch builder must use the shared shell
quoting mechanism; catalog membership alone is not an injection boundary.

### Transaction and Scheduling Constraints

Catalog discovery can involve a CLI subprocess, taskless disposable probe, provider
request, or cache refresh. It must not run inside the V1 idempotency database
transaction or a schedule-occurrence claim transaction. Split preparation from
pure persistence:

1. normalize/hash the V1 body and perform a side-effect-free idempotency lookup;
   exact replay returns the original Task and different-body reuse returns 409
   without any current catalog call;
2. only for a missing key, resolve owner/runtime/environment and validate a
   catalog snapshot outside the transaction;
3. keep transaction work limited to race-safe idempotency/claim rechecks and row
   writes using the prepared local result;
4. if missing-key preflight fails, perform a bounded same-key/same-body winner
   lookup so a concurrently committed Task wins over the stale external error;
5. admit only after the transaction commits, preserving the existing path.

Schedule create/update should validate its requested model for immediate user
feedback. Every future fire must revalidate because CLI versions, credentials,
policies, and provider availability can change. A missing model terminally fails
one occurrence; a transient catalog outage updates that same occurrence to a
bounded retrying state and terminally fails only on exhaustion. Neither creates
a `Task` nor a task-owned execution sandbox, and any taskless catalog probe must
be destroyed after each attempt.
Retry state keeps an immutable normalized task-template snapshot, so schedule
edits affect only future unclaimed occurrences; pausing suppresses automatic
retry. Once manual dispatch has accepted and persisted a terminal/retrying
outcome it returns the normal Schedule/latest-run representation rather than a
late REST/MCP transport error.
Startup recovery must reconstruct and admit the already-created task with its
persisted model; it must not lose or silently recatalog an existing task.

Catalog revision is useful for caching and diagnostics. It should not be a
required task/schedule request field in the first version, because a harmless
catalog refresh would otherwise change V1 idempotency body semantics or bind a
long-lived schedule to a historical revision.

### Deployment and Rollback Safety

Nullable columns do not make mixed versions semantically safe: an older worker
can strip an unknown direct/nested `model`, or ignore `Task.model` and its
immutable snapshot, and then launch a default model. An N-only gate cannot
protect requests routed to that N-1 schema. The first release therefore uses a
mandatory control-plane write maintenance window: migrate first, then before
publishing any model-aware contract/client close task/schedule write ingress
and MCP writing, stop/drain all N-1 API/admission/scheduler/runtime workers,
deploy N with a default-closed gate, and verify every remaining role reports
`task-model-selection-v1`. Only then open the gate and ingress together.
Delaying only the Console UI does not protect raw Public V1, MCP, or schedule
payloads. Mixed-version zero-downtime enablement is deferred until a predecessor
release can place an unavoidable raw-envelope gate in front of N-1 writers.

Closing the gate stops new explicit admission but model-aware workers continue
to honor already persisted intent while draining. Rollback pauses enabled
explicit-model schedules and drains/cancels every non-terminal explicit Task
and retrying occurrence before model-aware runtime workers are removed. The
rollback preflight blocks otherwise, and additive database columns remain.

### Domain Errors

Use transport-neutral error codes and map them separately at REST and MCP:

- `runtime_model_not_available`: syntactically valid selector is not in the
  current catalog; REST 422, MCP invalid-params style error.
- `runtime_model_catalog_unavailable`: the effective catalog cannot be obtained;
  REST 503, retryable MCP error.
- `runtime_model_setup_failed`: persisted explicit model intent could not be
  safely resolved or materialized before launch; structured Task failure.
- `runtime_model_rejected`: the CLI rejected a selector after preflight;
  structured Task failure with a choose-another-model action only when a pinned
  adapter receives trustworthy structured/stable rejection evidence. Generic
  exit codes or stderr matching must retain the existing auth/network/quota or
  generic failure classification.

Requested/actual substitution is an observable non-secret fact rather than a
transport error, and the first version does not accept a catalog-revision
precondition or add a catalog-changed 409.

MCP structured errors must carry the stable code and safe fields explicitly;
raw Nest exception/provider messages are not a reliable MCP contract.

### Verification Strategy

1. **Schema parity:** prove task-create fields are identical across Console,
   V1-minus-repoId, MCP `create_task`, and Schedule task template; prove every
   public operation has its exact manifest/controller/OpenAPI/MCP mapping.
2. **Persistence/read parity:** one full-field fixture round-trips through DB,
   create/get/list/stop responses, schedule template, schedule fire, and startup
   recovery with the requested model unchanged.
3. **Catalog adapters:** fixture the pinned Codex App Server `model/list` shape;
   test Claude subscription supported-subset mode; verify cache keys isolate
   owners, credentials, runtime, environment digest, and CLI version; bound
   time/output, enforce fair global/per-owner probe capacity, redact failures,
   and destroy successful/failed/cancelled/orphan taskless probes. Iterate every
   Claude manifest selector against its gated per-checksum compatibility
   evidence.
4. **Launch matrix:** Codex/Claude x interactive/headless x omitted/explicit
   model; assert exact safe argv, no flag when omitted, no shell injection,
   lookup/file failure cannot become default, re-adoption is stable, and current
   default launch is preserved.
5. **REST/MCP parity:** identical catalog input returns the same canonical
   result; scopes and owner derivation fail closed; model errors retain stable
   codes; a real MCP SDK `tools/list`/`tools/call` test sees both
   `list_runtime_models` and `create_task.model`.
6. **Idempotency and side effects:** exact replay after catalog outage/model
   removal returns the same Task with zero catalog calls; different-body reuse
   conflicts; invalid models create no Task or task-owned execution sandbox.
7. **Scheduled behavior:** create/update prevalidation, future-fire revalidation,
   transient bounded retry, terminal exhaustion, exactly-one occurrence/Task,
   immutable retry-template snapshot, pause/edit/manual-dispatch semantics, and
   recovery preservation.
8. **Release-image E2E:** run the catalog and selected-model smoke against the
   actual pinned AIO and BoxLite images; assert reported CLI version and compare
   `Task.model` with runtime-reported transcript model. Updating a CLI pin must
   regenerate the checked protocol/catalog fixture and rerun the matrix.
9. **Deployment compatibility:** prove an isolated N-1 REST/MCP writer can strip
   direct/nested model fields, then verify the maintenance cutover closes write
   ingress before model-aware clients are reachable, removes all N-1 roles, and
   requires N-only capability before reopening. Prove rollback preflight blocks
   on an explicit Task, enabled explicit schedule, or retrying occurrence.

The existing `packages/contracts/*.test.mjs` files are not currently wired into
a package `test` script, and V1 lacks a full-field forwarding fixture symmetric
with MCP. This change should make those tests part of the normal verification
lane rather than relying on source inspection alone.

### Proposed Scope

In scope:

- task requested-model contract, persistence, reads, runtime launch, and honest
  actual-model observation;
- one environment-aware model catalog service with Codex and Claude adapters;
- console picker, Public V1 operation, API Playground entry, and MCP tool;
- direct and scheduled task validation/revalidation;
- structured REST/MCP/schedule errors and cross-surface parity tests;
- removal of the Schedule MCP task-input drift relevant to shared task
  templates.

Deferred unless required to make the selected credential executable:

- general reasoning-effort/speed-tier selection;
- arbitrary model text entry outside the returned supported catalog;
- changing a model while resuming an existing session;
- implementing every currently stored but non-runnable Claude credential mode;
- a complete public/MCP catalog for unrelated task fields such as skills;
- a general public environment-management API. The model query must still work
  with the owner/deployment default and return the effective environment; a
  dedicated environment-list operation can be proposed separately.
