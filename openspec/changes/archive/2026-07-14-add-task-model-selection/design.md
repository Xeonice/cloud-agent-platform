## Context

CAP currently has one canonical `CreateTaskRequestSchema` shared by Console,
Public V1, MCP task creation, and schedule templates. The schema already carries
runtime and sandbox-environment selection, but task persistence, response
projection, provisioning lookup, launch context, and schedule recovery still
copy fields manually. A new field therefore becomes real only if it crosses all
of those seams.

The executable source of truth is the selected sandbox environment, not the API
host. Current AIO and BoxLite images pin Codex `0.144.1` and Claude Code
`2.1.207`; managed environment validation records resolved image identity and
toolchain metadata. Codex exposes structured non-interactive model discovery
through App Server `model/list`. Claude Code accepts `--model` but its pinned
CLI has no equivalent general non-interactive catalog command: a gateway may
provide an authoritative `/v1/models`, while a direct subscription requires an
honestly labeled version-verified supported subset.

The external surface has good task-field reuse but incomplete discovery parity.
Public V1 currently contains 17 data operations and MCP maps 16 tools, with SSE
as the one intentional REST-only operation. Runtime readiness and sandbox
environment lists are unversioned REST-only, and schedule MCP outer inputs still
contain manually copied schema shapes. This change must make model discovery a
first-class manifest operation and add structural parity tests rather than rely
on another hand-maintained list.

Two transaction boundaries constrain the design. V1 task row creation happens
inside the idempotency transaction, and scheduled occurrences currently claim
and create a task in one transaction. Model discovery can execute a CLI probe,
start a disposable sandbox, or call a provider, so it cannot occur within either
database transaction.

There is also a pre-existing Claude credential boundary to close for this
feature: the Settings data model can store subscription and API-key modes plus
`defaultModel`, but the current runtime source resolves a process-global first
subscription and does not inject API-key mode. Catalog and launch must use the
same task owner. This design owner-scopes the supported Claude subscription
path, but does not claim API-key mode is executable until its separate secure
injection path exists.

## Goals / Non-Goals

**Goals:**

- Let a caller choose an optional model for a new Codex or Claude Code task and
  preserve that requested selector across every creation and read surface.
- Derive selectable models from the effective owner, runtime, credential,
  policy, environment/image, and packaged CLI version.
- Give Console, Public V1, API Playground, and MCP one shared model catalog and
  one set of model-domain errors.
- Validate explicit selectors before Task/task-owned execution-sandbox creation
  while keeping CLI or provider I/O outside database write transactions and
  reclaiming any taskless catalog probe.
- Apply a validated selector safely to all four fresh-launch paths: two runtimes
  by interactive/headless mode; keep resume behavior stable.
- Revalidate explicit scheduled models at each fire, bounded-retry transient
  catalog outages, and record structured terminal pre-task failures without a
  Task or task-owned execution sandbox.
- Verify the complete real seam and all existing task-create fields so earlier
  V1/MCP parity does not regress.

**Non-Goals:**

- Choosing reasoning effort, speed/service tiers, modalities, or other
  runtime-specific model options.
- Changing the model of an existing/resumed agent session.
- Accepting arbitrary free-text models that are absent from the effective
  catalog.
- Treating a requested alias as proof of the actual model used; runtime-reported
  session metadata remains authoritative for the actual value.
- Making Claude API-key/gateway credentials execution-ready, or claiming a
  complete subscription entitlement list when no authoritative discovery
  source exists.
- Adding unrelated Public V1/MCP catalogs for skills, runtime readiness, or
  sandbox-environment management. Their current discovery gaps are recorded in
  `research-brief.md` for separate follow-up.
- Pinning a task or long-lived schedule to a catalog revision supplied by the
  client.

## Decisions

### 1. Store one optional requested selector on Task

Add `model?: string` to `CreateTaskRequestSchema`, nullable `model` to canonical
task responses, and `Task.model String?` in Prisma. The input is trimmed, has a
conservative maximum length (2048 bytes after UTF-8 validation), rejects empty,
null-byte, and control-character values, and otherwise allows punctuation used
by aliases and provider-qualified ids. Do not create separate `codexModel` and
`claudeModel` fields.

`Task.model` is caller intent. Null means "use the effective runtime default".
It is never backfilled from a credential default and is never overwritten by
alias resolution or a runtime event. The independently observed actual model
continues to live in `SessionHistory.meta.model` through the existing Codex and
Claude transcript parsers. Task details may compare the two values and expose a
safe substitution warning.

An explicit task selector has launch precedence over a credential-configured
default; omission preserves the runtime's existing credential/CLI default. The
catalog revision is diagnostic only and is not stored in the task request or
schedule template, so a cache refresh does not change V1 idempotency semantics.

Alternatives considered:

- Persisting the resolved concrete model loses caller intent when an alias is
  used and falsely treats preflight as proof of runtime behavior.
- Runtime-specific fields force every shared create/read consumer to branch and
  make adding a third runtime harder.
- A static enum in Zod/OpenAPI/MCP cannot represent environment- and
  credential-dependent provider ids and would drift from packaged CLI pins.

### 2. Introduce a contextual catalog contract and service

Add shared request and response schemas approximately shaped as follows (exact
names remain in `@cap/contracts`):

```ts
type RuntimeModelCatalogQuery = {
  runtime: 'codex' | 'claude-code';
  sandboxEnvironmentId?: string | null;
};

type RuntimeModelCatalog = {
  runtime: 'codex' | 'claude-code';
  effectiveEnvironment:
    | {
        kind: 'managed';
        id: string;
        name: string;
        provider: string;
        fingerprint: string;
      }
    | {
        kind: 'deployment-default';
        id: null;
        name: string;
        provider: string;
        fingerprint: string;
      };
  cliVersion: string;
  source:
    | 'codex-app-server'
    | 'compatible-provider'
    | 'versioned-cli-capabilities';
  completeness: 'complete' | 'supported-subset';
  revision: string; // opaque, non-secret
  defaultModel: string | null;
  models: Array<{
    id: string;
    displayName: string;
    isDefault: boolean;
    availabilityEvidence: 'account-discovered' | 'cli-version-verified';
  }>;
};
```

`RuntimeModelCatalogService` accepts an authenticated owner plus the canonical
query; callers cannot provide `userId`. It first invokes the same environment
resolver as task creation, preserving all three states:

- property omitted: owner-managed default, then normal fallback;
- explicit null: bypass owner default and use deployment fallback;
- UUID: that exact ready, owner-usable, runtime-compatible environment.

The shared resolver must close the gap between a selectable source tag and an
actual execution snapshot. For a managed environment it joins the current
passed validation and resolves provider, content-addressed digest (or
provider-equivalent checksum), validated sandbox metadata, and CLI version. For
the deployment fallback it resolves the configured provider source to the same
kind of immutable snapshot even though no managed id exists. If an explicit
model cannot be bound to such an identity, catalog/create fails closed; it must
not cache by a mutable tag and hope provisioning later sees the same image.

It then resolves the owner's execution-ready credential/policy, selects a
runtime adapter, normalizes safe metadata, computes an opaque revision over the
validation-relevant response, and returns deterministic ordering. Public
responses never contain credentials, private endpoints, raw response bodies,
or raw CLI stderr. The discriminated environment union is required because an
explicit-null deployment fallback may have no managed-environment UUID; its
opaque fingerprint represents the resolved provider/image/toolchain context
without exposing a private image source or endpoint.

Alternatives considered:

- A GET query cannot preserve omitted versus explicit-null environment intent
  as reliably across Console, OpenAPI, and MCP clients; a small POST query body
  matches the task contract and is still read-only.
- Reusing `/settings/codex/models` would expose a Settings-only API that accepts
  candidate secrets and would not cover selected environments or Claude.
- Putting catalogs on sandbox-environment records would mix global toolchain
  capability with per-owner credentials and policies and quickly become stale.

### 3. Runtime adapters use bounded sources with explicit authority

Use a `RuntimeModelCatalogAdapter` port selected by runtime and credential mode.
All adapters receive an already resolved environment fingerprint, CLI version,
owner-scoped credential handle, and policy; none may inspect a developer CLI.

For Codex official credentials, generalize the existing bounded App Server
client and disposable runner to execute `model/list` in a short-lived probe of
the effective environment image. Preserve protocol ordering/default metadata,
support pagination, and extend the checked App Server schema fixture tied to the
Codex image pin. The probe mechanism must support AIO, BoxLite, and managed
custom environments rather than silently falling back to the deployment's
default AIO image. Introduce a taskless `RuntimeModelCatalogProbe` lifecycle
port: create with catalog-specific labels, enforce concurrency and absolute
timeout, apply global plus per-owner limits through a fair bounded queue, cancel
safely, destroy in `finally`, and reconcile orphan probes after process failure.
An owner over its queue allowance receives safe retryable capacity data without
allocating another probe. A catalog probe is not a Task admission or task-owned execution
sandbox and never creates a Task row/session.

For an execution-ready Codex-compatible credential, reuse the existing bounded
`ModelDiscoveryClient` and its SSRF, redirect, timeout, and response-size
protections. Resolve base URL and API key from the owner on the server; the
public catalog request never accepts them. Provider results are still filtered
through Codex/environment compatibility.

For Claude Code direct subscription, store a versioned capability manifest
alongside the packaged Claude CLI pin and return it as `supported-subset`. Each
entry records its documentation/protocol provenance, and CI fails when
Dockerfile pins and the manifest compatibility fixture diverge. Do not scrape
the interactive `/model` picker and do not label the subset as the owner's
complete entitlement list. Apply any effective model restriction that the
supported execution path actually enforces. An authoritative gateway
`/v1/models` adapter is deferred until that credential/gateway path is itself
execution-ready; the adapter port can accept it additively later.

Every Claude manifest selector needs provenance and successful gated launch
evidence against each unique packaged Claude CLI artifact checksum. AIO and
BoxLite may share that selector matrix when their CLI package checksums are
identical, while each provider still gets a representative end-to-end launch
seam smoke. Entries without current evidence are omitted. Because this proves
CLI compatibility rather than the querying owner's complete entitlement, items
are labeled `cli-version-verified`; Codex/App Server or provider results derived
from the owner are labeled `account-discovered`.

Change the supported Claude auth source to accept an explicit authenticated
`ownerUserId` instead of using an unscoped `findFirst`. Catalog/preflight calls
it before a Task exists; provisioning obtains the same id from the persisted
Task and calls the same port. Stored API-key mode remains not-ready and returns
no model catalog until a future change implements its secure runtime injection.
Likewise, `defaultModel` is reported or applied only when the effective launch
path actually consumes it; an inert stored value cannot be advertised as the
effective default.

Alternatives considered:

- Running `codex --help` or `claude --help` on the API host verifies flags, not
  the selected image or owner entitlements.
- Scraping terminal pickers is presentation-dependent, hard to bound, and
  unsuitable for a machine contract.
- Claiming a hardcoded Claude list is complete hides entitlement and release
  drift. A pin-bound supported subset is narrower but honest and testable.

### 4. Prepare model-aware task creation before pure writes

Introduce one internal preparation stage used by Console, V1, MCP, and schedule
paths. Console and MCP call it directly before the pure write. V1 first resolves
idempotency without external work:

```text
normalize body + hash exact body including model
  -> V1 side-effect-free idempotency lookup
       same key + same body -> return original Task, no catalog call
       same key + different body -> 409, no catalog call
       missing key -> continue
  -> shared preparation outside transaction
       resolve repo/runtime/environment/credential readiness
       if model is explicit: obtain current catalog and validate membership
       produce PreparedTaskCreate (normalized body + immutable local context)
       on preflight error: bounded same-key winner lookup before returning it
  -> short transaction
       race-safe idempotency/claim recheck + row writes only
  -> post-commit admission
```

If `model` is omitted, preparation does not query the catalog; this preserves
current default behavior during a catalog outage. If it is explicit, syntax and
membership failures for a new request happen before Task/task-owned execution
sandbox creation. The prepared value contains only normalized, local data
required by the write, including the exact immutable environment snapshot used
by the catalog. The Task persists that non-secret snapshot, and
`ProvisionLookup`/recovery use it to pin provider provisioning to the same
digest/checksum and CLI metadata instead of resolving the current tag/default
again. No subprocess, catalog probe, provider HTTP request, or cache refresh
runs from `createTaskRow`, the transactional idempotency callback, or a Prisma
transaction.

V1 continues hashing the exact normalized request body, including `model`.
Therefore the same key/body/model returns the original Task even if that model
later disappears or catalog discovery is down, while the same key with a
different model remains a different-body 409 without a catalog call. Two
concurrent missing-key requests may both preflight, but the transaction-level
recheck creates one Task and returns it to the loser. Catalog revision is not
part of the request hash. If one concurrent preflight fails while another
same-key/same-body request may be committing successfully, the failing path
performs a bounded side-effect-free lookup/poll before returning 422/503; a
completed same-body winner is replayed, while a different-body winner remains
409. If no winner appears within that bound, the safe error is returned and any
later exact retry still resolves to a winner that subsequently committed. A
short race always exists between successful
preflight and CLI launch; launch rejection is captured as structured Task
failure rather than silently substituting a model.

Alternatives considered:

- Discovering in `createTaskRow` looks centralized but holds open both V1
  idempotency and schedule occurrence transactions across external I/O.
- Performing model preflight before the initial idempotency lookup breaks replay
  guarantees when a previously accepted model or its catalog later disappears.
- Validating only in the browser leaves V1/MCP unprotected and cannot handle
  schedule drift.
- Validating only at CLI launch creates an avoidable Task/sandbox for known bad
  input and gives synchronous callers poor feedback.

### 5. Carry the selector through a file-backed, provider-neutral launch seam

Extend `ProvisionLookup` with a required model-intent lookup and propagate a
discriminated result through every sandbox/integration launch context and call
site:

```ts
type TaskModelIntent =
  | { kind: 'runtime-default' }
  | { kind: 'explicit'; selector: string };
```

Lookup exceptions are not converted to `runtime-default`. The asynchronous
terminal/provisioning context resolver must obtain model intent alongside
runtime and execution mode before constructing the runtime `LaunchContext`.
For an explicit model, shared setup writes the UTF-8 selector through the same
base64/file-material mechanism already used for prompt and credentials to a
fixed task-local path. The runtime launch policy requires that path to exist,
be readable, and contain the expected non-empty material, then passes its value
as exactly one double-quoted `--model` argument. Raw model text is never
concatenated into the nested tmux shell command. File permissions and lifecycle
follow the existing task setup-material policy even though a model id is not
secret.

Codex and Claude implement this in both interactive and headless fresh-session
builders. When `model` is null, no selector material or command fragment is
added and the old launch output remains byte-identical. Resume/reconnect builders
do not add a model override and preserve the original session. Shared AIO,
BoxLite, terminal, and provider code consumes the declarative runtime setup and
never branches on runtime identity.

If explicit intent cannot be looked up, propagated, materialized, or read,
classify the Task as `runtime_model_setup_failed` and do not start a default
fresh session. Admission recovery for a not-yet-started Task rematerializes its
persisted explicit selector or fails closed. Only a successfully resolved
persisted null takes the byte-identical default branch.

If the CLI rejects a selector after preflight, classify the Task with stable
`runtime_model_rejected` and an actionable "choose another model" action only
when a runtime adapter observes a structured event or stable error code covered
by the pinned compatibility fixture. Never regex-match presentation text or
map every explicit-model non-zero exit to that code: authentication, network,
quota, and generic process failures retain their existing classifiers. If the
pinned CLI offers no reliable evidence on a launch path, report the honest
generic failure instead of promising a model-specific diagnosis.
If runtime transcript metadata reports a different actual model, preserve both
values and emit a safe substitution diagnostic; do not rewrite `Task.model`.

Alternatives considered:

- Direct string interpolation, even after catalog membership, is unsafe for
  slashes, brackets, quotes, provider ARNs, and nested tmux quoting.
- Restricting ids to an alphanumeric regex avoids some quoting work but rejects
  valid provider-qualified selectors and still is not an argument boundary.
- Applying `--model` on resume can change or invalidate an existing session and
  is a separate product behavior.
- Treating a lookup/file error as null silently violates persisted task intent
  and can run a different, more expensive, or policy-incompatible model.

### 6. Schedule preflight occurs outside the occurrence transaction

Schedule create/update calls the shared preparation/catalog validation before
its short write transaction. A failure leaves the prior schedule unchanged.
The normalized template stores only the requested selector; null means each
future task follows the effective default at that fire.

For every due, manual, or recoverable not-yet-created occurrence:

1. build a candidate dispatch and validate its explicit model outside Prisma;
2. on success, enter the existing claim transaction, re-check the schedule
   version/lease, create or update the unique occurrence ledger, advance the
   schedule, and atomically create at most one Task using prepared data;
3. when the selector is definitively absent, enter `persistFailedOccurrence`,
   win the same version/lease claim, advance scheduling state, and write one
   terminal failed ledger entry with null `taskId`,
   `runtime_model_not_available`, and safe text;
4. on transient `runtime_model_catalog_unavailable`, enter
   `persistRetryingOccurrence`, win/update the same occurrence identity, keep
   automatic cadence unadvanced (and leave manual-dispatch cadence unchanged),
   and persist `retrying`, attempt count, a bounded jittered `retryAt`/claim
   lease, and an immutable normalized task-template snapshot without creating a
   Task;
5. when retry time arrives, preflight again and update that same ledger row; on
   success follow step 2, while exhausting a configurable attempt/time horizon
   transitions it to terminal failed and advances cadence according to the
   schedule's misfire policy;
6. if another worker already won any CAS, discard this candidate result;
7. after a successful Task commit, use the existing post-commit admission path.

Multiple workers may perform the same bounded cached preflight, but only one can
claim/write the occurrence. Retry scanning is driven by the run's persisted
`retryAt`, not by inventing another schedule fire. A retrying row is durable
across restart and can become created at most once; retries use its captured
template even if the schedule is edited. An automatic retry performs no work
while the schedule is paused and can resume only within its retry horizon. A
terminal pre-task failure never creates a late Task. If a Task row already exists, startup admission recovery uses its
persisted model and does not treat it as a new catalog validation. Add
`retrying` to run status and nullable `errorCode`, `retryAt`, and attempt metadata
plus an internal immutable template snapshot to persistence; expose only the
safe retry fields through latest-run/list schemas. Raw adapter diagnostics are
never stored. A taskless catalog probe may exist during preflight, but it must
be destroyed before each attempt completes and is never exposed as the Task's
execution sandbox.

Manual dispatch is an accepted occurrence command, not a synchronous template
validation request. Once it persists a terminal-failed or retrying ledger row,
REST and MCP return their normal Schedule response with `latestRun`; they do not
return 422/503 after committing state. The 422/503 transport mappings apply to
catalog queries, direct task creation, and schedule create/update, where no
occurrence has yet been accepted.

Alternatives considered:

- Moving the provider/CLI call into the current claim transaction makes a
  slow external dependency part of scheduler lock duration and retry behavior.
- Creating a Task for a known preflight error improves task-centric audit but
  violates the requested no-Task/no-task-execution-sandbox failure semantics.
  The run ledger is the correct audit object before task creation.
- Immediately consuming a transient catalog 503 would contradict its retryable
  contract and silently skip a scheduled occurrence; a bounded durable retry
  keeps reliability without retrying forever.
- Capturing the concrete default at schedule creation makes an omitted model
  silently static. Omission instead retains explicit "follow effective default"
  intent.

### 7. Public V1, MCP, Playground, and Console share one manifest contract

Add `POST /v1/runtime-models/query` to `PUBLIC_V1_OPERATIONS`, raising the data
operation count from 17 to 18. It requires `tasks:write`, because a credential
authorized to create must be able to preflight. It is read-only despite POST and
does not accept `Idempotency-Key`. The Console calls this same endpoint using its
session principal rather than a second unversioned controller. OpenAPI and the
API Playground derive the operation and schemas from the manifest.
The route uses the existing per-principal request throttle and documents 429;
the shared catalog service additionally enforces owner-fair probe capacity for
both REST and MCP.

Map it explicitly to MCP `list_runtime_models`, raising mapped tools from 16 to
17 while SSE remains the only REST-only exclusion. MCP uses exact shared input
and output schemas and derives owner from `AuthInfo.extra.userId`. Task and
schedule MCP inputs must either use canonical schemas directly or have a
structural parity assertion over the SDK-advertised input, parsed callback
input, and shared contract, so unknown-field stripping cannot erase `model`.
MCP `create_task` then calls the same shared preflight, pure write, and admission
services as Console/V1; it does not stop at schema forwarding.

Use transport-neutral domain errors:

| Domain code | REST | MCP |
| --- | --- | --- |
| `runtime_model_not_available` | 422 | invalid-params style error with structured code |
| `runtime_model_catalog_unavailable` | 503 + retryable safe data | retryable structured tool error |

Environment/readiness errors keep their existing domain semantics. REST and MCP
map the domain objects separately and expose allowlisted context only. The first
version does not expose a client revision precondition, so it does not add a
catalog-changed 409 contract. `dispatch_schedule` is the explicit exception to
synchronous model-error mapping: after it persists an occurrence, both
transports return the canonical Schedule response and its latest-run outcome.

Alternatives considered:

- A Console-only endpoint recreates discovery drift and makes MCP clients guess
  valid model ids.
- A static MCP enum becomes wrong when the selected environment, provider, or
  credential changes.
- Letting Nest exceptions pass through MCP produces unstable protocol errors and
  leaks HTTP implementation details.

### 8. Catalog cache keys model every availability boundary

Use a bounded TTL cache with in-flight request coalescing. Its key includes:

```text
owner id + runtime + credential mode/revision + policy revision
+ resolved environment id/image digest + sandbox metadata checksum + CLI version
```

Never share credential-aware entries across owners. Expired entries are not used
to validate a new explicit model when refresh fails; return catalog unavailable.
Mutable source tags are never cache identities: the shared resolver must first
produce the exact provider digest/checksum and validated CLI metadata that the
Task will persist and provision. If it cannot, explicit-model resolution is not
cached and fails closed.
Source-specific timeouts, pagination limits, redirects, and response-size bounds
remain enforced below the cache. Revision is an opaque hash of normalized safe
context plus ordered validation-relevant models; it changes when that effective
catalog changes and is intended for UI refresh and diagnostics, not authorization
or idempotency.

Alternatives considered:

- Keying only by runtime/CLI leaks owner entitlements and ignores account policy.
- Caching by an environment tag ignores mutable tag retargeting; resolved digest
  and validated metadata are required.
- Serving indefinitely stale data allows known removed selectors to pass
  preflight during provider failure.

### 9. Explicit selection opens only after a model-aware worker cutover

Explicit model selection ships behind a deployment-wide
`task-model-selection-v1` write/dispatch gate that is closed by default. The
gate covers every model-aware N catalog route/tool, direct task creation,
schedule create/update with an explicit model, and due/manual dispatch of an
explicit-model occurrence. A closed gate returns safe retryable catalog-
unavailable semantics before persistence or probing. Requests that omit
`model` retain the pre-feature path and do not depend on this gate.

This gate cannot protect a request routed to an N-1 writer: its older Zod/MCP
schema may strip the unknown direct or nested `model` field and create a
default-model Task. Therefore the first release requires a control-plane write
maintenance window rather than a mixed-version serving rollout. The database
migration may run first, but before any model-aware schema, client, Playground,
or MCP tool is published/reachable, deployment closes external task/schedule
write ingress, disables MCP task writers, stops/drains every N-1 API,
admission, scheduler, and runtime claimer/launcher, and deploys N with its gate
closed. Only after every remaining role reports `task-model-selection-v1` may
the gate and write ingress open coherently. Merely hiding the Console selector
is insufficient because callers can send raw REST/MCP payloads.

Future mixed-version zero-downtime enablement would require a preparatory
release that places a raw-envelope gate at an ingress every N-1 writer cannot
bypass (including nested schedule templates) and routes model-aware MCP only to
N. That prerequisite is intentionally not claimed by this change.

The gate controls new admission, not interpretation of already accepted work.
Every N worker must always honor or fail closed on a persisted explicit model
and immutable snapshot even while the gate is closed, so closing it starts a
safe drain. Rollback first closes the gate across all N writers/dispatchers,
pauses every enabled schedule whose template has an explicit model, and waits
for or explicitly cancels every non-terminal explicit-model Task and retrying
occurrence. A rollback preflight blocks removal of N workers until no legacy
worker could later recover or fire such work. Additive columns remain in place.

Alternatives considered:

- Nullable-schema compatibility alone protects reads but not semantics: an old
  writer can strip a requested model and an old launcher can silently turn
  explicit intent into the runtime default.
- An application heartbeat cannot fence an already running old binary unless
  write ingress is closed and the deployment can enumerate and stop it; the
  initial release therefore mandates a maintenance cutover.
- A UI-only flag leaves Public V1, MCP, manual dispatch, and due schedules able
  to create unsafe work.

### 10. Verification uses production seams and generated parity, not mirrored logic

Verification is layered but follows one end-to-end story:

1. Contract tests introspect canonical schemas and prove Console, V1 minus
   `repoId`, MCP advertised/callback inputs, and schedule templates expose the
   same task fields, including all fields added before `model`; byte-boundary
   tests use `Buffer.byteLength` rather than Zod character count.
2. Persistence tests create a real-shaped Task row and verify create/get/list,
   schedule template/retry ledger, recovery projection, nullable migration
   behavior, immutable environment snapshot reuse, and V1 two-stage idempotency.
   Exact replays after model removal or catalog outage must return the original
   Task with zero catalog calls; mutable-tag retarget after preflight must not
   change the launched digest/CLI.
3. Adapter tests execute production catalog adapters against bounded protocol
   fixtures: Codex pagination/default/hidden/malformed/timeout/oversize;
   compatible-provider SSRF/redirect/auth/body bounds; Claude pin-manifest drift
   and supported-subset/evidence labeling; every Claude manifest selector is
   iterated by the gated per-unique-CLI-artifact launch matrix; catalog-probe success/timeout/cancellation,
   teardown, concurrency, and orphan reconciliation. Fixture model ids are test
   data, never product allowlists duplicated inside tests.
4. Runtime seam tests invoke the production launch builders across runtime ×
   execution mode × omitted/explicit selectors, inspect argv at the process
   boundary, cover punctuation/injection payloads, credential-default override,
   resume behavior, byte-identical omission, lookup errors, missing/unreadable
   material, and re-adopted fresh launch.
5. REST/MCP integration tests run the same owner/context fixture through catalog,
   create/get/list, schedule create/update/fire, domain errors, scope/owner
   denial, OpenAPI, operation counts, and structured output.
6. Scheduler concurrency/recovery tests prove discovery is outside transactions,
   one worker wins, permanent failure produces one terminal ledger row/no Task,
   transient catalog failure retries the same occurrence with bounded backoff,
   exhaustion creates no late Task/task-owned execution sandbox, and an
   already-created Task recovers with its persisted model.
7. Gated image E2E runs catalog → create → launch → transcript against both
   packaged AIO and BoxLite environments for Codex and Claude subscription. It
   asserts `Task.model` equals request intent while `SessionHistory.meta.model`
   equals runtime evidence or remains explicitly unknown.
8. Deployment compatibility verification sends direct and nested explicit-model
   payloads to an isolated N-1 writer and records the unknown-field stripping/
   default-launch hazard. The cutover test then proves external write ingress
   and MCP writing are closed before any model-aware contract is exposed, no
   request can route to N-1, every remaining role is N-capable before reopening,
   N workers still honor accepted explicit work after gate closure, and rollback
   preflight blocks while explicit work remains.

Tests SHALL call production schemas, services, adapters, and launch builders.
They SHALL NOT reimplement the catalog or launch algorithm merely to satisfy an
expected fixture. Pin compatibility checks tie capability fixtures to both
Dockerfiles so a CLI upgrade cannot merge without an intentional catalog review.

## Risks / Trade-offs

- **[Claude has no authoritative direct-subscription catalog]** → Return a
  version-bound `supported-subset`, keep provenance with the CLI pin, apply
  policy, and never label it complete.
- **[Catalog preflight can become stale before launch]** → Keep the race window
  short, validate from a fresh bounded cache, and classify launch rejection
  structurally; no discovery system can guarantee a provider remains unchanged.
- **[Idempotent replay occurs after catalog drift]** → Resolve an existing
  key/body before external preflight and recheck only missing keys in the write
  transaction, so historical exact replay never depends on current catalog.
- **[CLI probes add latency and resource cost]** → Use owner/context-isolated
  TTL caching and in-flight coalescing, strict timeout/output limits, and no
  catalog lookup for omitted models.
- **[Taskless catalog probes can leak provider resources]** → Give probes a
  dedicated labeled lifecycle port with concurrency/timeout bounds, guaranteed
  teardown, orphan reconciliation, and provider-specific cleanup tests.
- **[Custom environment cannot run a supported probe]** → Fail the explicit
  catalog closed with a safe reason; do not silently consult the default image.
- **[Mutable image tag retargets between catalog and launch]** → Resolve and
  persist one provider-specific immutable environment snapshot before probing,
  pin provisioning/recovery to it, and disable explicit selection/caching when
  no immutable identity can be established.
- **[Claude owner scoping touches pre-existing auth code]** → Add owner-isolation
  integration tests and keep unsupported API-key mode disabled instead of
  broadening credential work implicitly.
- **[Schedule validation before claim can duplicate probes across workers]** →
  Coalesce cache work; retain the existing version/lease CAS as the sole writer
  and discard losing candidate results.
- **[Transient catalog outage can skip a schedule or retry forever]** → Persist
  one retrying occurrence with bounded jittered backoff/attempt horizon; create
  at most one Task on recovery and terminally fail/advance on exhaustion.
- **[Nested shell/tmux quoting can regress launch]** → Use fixed-path file
  material and quoted expansion, plus real process-boundary tests with hostile
  punctuation for all fresh-launch paths.
- **[An N-1 worker ignores new semantic fields during rolling deployment]** →
  Do not serve mixed versions: close write ingress/MCP before model-aware
  contracts are reachable, drain/stop all N-1 writers and claimers in a
  mandatory maintenance window, then verify N capabilities and open the gate.
  Drain/pause explicit work before rollback. Nullable columns and an N-only gate
  are not sufficient compatibility guarantees.

## Migration Plan

1. Add nullable `tasks.model` and non-secret resolved-environment snapshot plus
   `task_schedule_runs.error_code`, `retry_at`, retry-attempt, and internal
   normalized-template snapshot fields and the additive `retrying` status.
   Backfill is unnecessary: existing rows retain null/default intent and
   existing run errors remain text-only with no retry metadata.
2. Update and verify AIO/BoxLite catalog fixtures, taskless probes, launch
   compatibility, contract/parity, database, API/MCP, scheduler, and gated
   real-credential suites before making a model-aware client reachable.
3. Enter a mandatory control-plane write maintenance window: close task and
   schedule write ingress, disable MCP writers, and stop/drain all N-1 API,
   admission, scheduler, and runtime workers. Do not rely on an N gate to reject
   payloads that could still reach an N-1 schema.
4. Deploy N contracts/API/admission/scheduler/runtime changes with
   `task-model-selection-v1` closed. Verify every remaining role reports the
   capability, can safely read/launch persisted explicit intent, and keeps
   omitted-model launch byte-identical.
5. Coherently open the server gate and write ingress, then publish/enable the
   Console selector, V1/OpenAPI/Playground contract, and MCP catalog/tool. Warm
   no credential-aware cache before authenticated post-enable queries.

Rollback closes the server gate on all N writers and schedule dispatchers
before removing any runtime support. Pause every enabled explicit-model
schedule, drain or explicitly cancel all non-terminal explicit-model Tasks,
and resolve/terminally close all retrying explicit-model occurrences. A
rollback preflight must prove those sets are empty before N workers are
downgraded; otherwise rollback stops. The additive columns and paused template
values remain until a later cleanup migration rather than being destructively
removed. Mixed-version explicit-model enablement is not supported in this
change.

## Open Questions

No decision blocks implementation. Future changes may decide whether to make
Claude API-key/gateway execution first-class, publish general runtime/environment
discovery through Public V1/MCP, or add catalog revision preconditions. Those
are intentionally outside this change and must not weaken the first version's
owner scoping or fail-closed model validation.
