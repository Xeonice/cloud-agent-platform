## ADDED Requirements

### Requirement: Model catalogs resolve in the task owner's effective execution context

The system SHALL resolve a runtime model catalog for the authenticated owner,
the requested `codex` or `claude-code` runtime, and the effective sandbox
environment. The request SHALL preserve the task-create environment semantics:
an omitted `sandboxEnvironmentId` uses the owner's managed default, explicit
`null` bypasses that owner default and uses the deployment fallback, and a UUID
selects that exact ready and runtime-compatible environment. Resolution SHALL
use the effective owner credential and policy plus the CLI/toolchain version
declared by the resolved environment, and SHALL NOT accept a client-supplied
owner id or use a CLI installed on the API host as the source of truth.

#### Scenario: Omitted environment resolves the owner default

- **WHEN** an authenticated owner queries a runtime catalog without a `sandboxEnvironmentId`
- **THEN** the system resolves the same managed default environment that a task create with an omitted environment would use
- **AND** the catalog is derived from that environment's runtime CLI version and the owner's effective credential and policy

#### Scenario: Null environment bypasses the owner default

- **WHEN** an authenticated owner queries a runtime catalog with `sandboxEnvironmentId: null`
- **THEN** the system uses the same deployment fallback selected by a task create with explicit null

#### Scenario: Explicit environment must be usable

- **WHEN** an owner queries a catalog for an unknown, retired, unready, inaccessible, or runtime-incompatible environment UUID
- **THEN** the query fails with the same safe environment-resolution semantics used by task creation
- **AND** no credential, sandbox, task, or provider side effect is created

### Requirement: Catalog responses are stable, ordered, honest, and non-secret

A successful catalog response SHALL contain the runtime, a safe discriminated
effective-environment summary, effective CLI version, catalog source,
completeness, revision, nullable default model, and a deterministic ordered
`models` array. The environment summary SHALL distinguish a managed environment
from the deployment fallback, use a nullable managed-environment id, and include
an opaque non-secret execution fingerprint for either branch.
Every model item SHALL contain an exact selector `id` accepted by task creation,
a display label, availability evidence (`account-discovered` or
`cli-version-verified`), and additive non-secret capability metadata when known. The
response SHALL distinguish an authoritative complete catalog from a constrained
or best-known catalog and SHALL NOT expose credentials, authorization headers,
private provider endpoints, raw provider bodies, or raw CLI stderr.

#### Scenario: A complete catalog is returned deterministically

- **WHEN** the effective runtime exposes an authoritative structured model list
- **THEN** repeated queries for an unchanged execution context return the same revision and deterministic model ordering
- **AND** the response marks the catalog as complete and identifies the default model when the source provides one

#### Scenario: A constrained catalog is labeled honestly

- **WHEN** the effective CLI supports only a verified subset that CAP can enumerate but does not expose the owner's complete entitlement list
- **THEN** the response marks its completeness as constrained or best-known rather than complete
- **AND** each item is labeled `cli-version-verified` rather than falsely claiming current-account discovery

#### Scenario: Deployment fallback is represented without a managed id

- **WHEN** explicit-null environment resolution selects a deployment fallback that has no managed environment row
- **THEN** the catalog response identifies the effective environment as `deployment-default`, returns a null managed id, and includes its opaque execution fingerprint and CLI version

#### Scenario: Secrets and unsafe diagnostics are redacted

- **WHEN** a catalog adapter succeeds or fails after consulting a credential, CLI, or provider
- **THEN** its public response and logs contain only allowlisted metadata and stable safe error details
- **AND** credential material, private endpoints, raw response bodies, and raw CLI stderr are absent

### Requirement: Runtime adapters discover only models supported by the effective CLI path

Each runtime adapter SHALL prefer a bounded, structured, non-interactive model
discovery interface exposed by the effective sandbox CLI or configured
provider, and SHALL apply the effective account policy before returning model
ids. It SHALL NOT scrape an interactive picker or terminal presentation. When
an authoritative discovery interface is unavailable, an adapter MAY return a
version-bound set of selectors only if those selectors are verified against
the packaged CLI and the catalog is marked non-complete; otherwise the catalog
query SHALL fail closed as unavailable. Compatible-provider discovery SHALL
remain bounded by the provider and runtime compatibility rules instead of
assuming every provider id is launchable.

The adapter SHALL advertise models only for a credential mode that the selected
runtime can actually inject and execute for that owner. A credential shape that
is stored by Settings but is not supported by the runtime execution path SHALL
fail with the existing safe credential/runtime-readiness semantics rather than
returning a misleading catalog.

#### Scenario: Codex structured discovery follows the packaged CLI

- **WHEN** the selected Codex environment and credential support structured model discovery
- **THEN** the Codex adapter returns the structured CLI/provider results after effective policy filtering
- **AND** it does not parse Codex TUI output or consult a developer-machine Codex installation

#### Scenario: Claude subscription uses a verified supported subset

- **WHEN** an owner has a supported Claude subscription and the packaged CLI has a version-verified selector capability manifest
- **THEN** the Claude adapter returns only selectors from that manifest that the effective execution path permits
- **AND** it labels the catalog as a supported subset rather than a complete entitlement list

#### Scenario: Every Claude manifest selector has compatibility evidence

- **WHEN** a Claude selector is considered for the versioned capability manifest
- **THEN** production verification must have exercised that selector against each unique packaged Claude CLI artifact checksum with a gated reference subscription
- **AND** a selector without current provenance and successful compatibility evidence is omitted from the manifest

#### Scenario: CLI evidence is not owner entitlement evidence

- **WHEN** the Claude supported subset is returned to an owner whose complete entitlement cannot be discovered non-interactively
- **THEN** every item is marked `cli-version-verified` and the catalog does not claim account-level availability
- **AND** any trustworthy later runtime rejection is reported without rewriting the catalog evidence or requested selector

#### Scenario: No trustworthy source is available

- **WHEN** CAP cannot establish a trustworthy model set for the effective runtime, CLI version, credential, and policy
- **THEN** the catalog query fails with `runtime_model_catalog_unavailable`
- **AND** it does not invent a complete list or scrape an interactive picker

#### Scenario: Stored but unexecutable credential mode is not advertised

- **WHEN** Settings contains a credential mode that the selected runtime cannot currently inject into a task owned by that account
- **THEN** catalog resolution reports the credential/runtime as not execution-ready and returns no selectable models
- **AND** it does not imply that saving a credential makes that mode launchable

### Requirement: Explicit task models are validated against a current catalog

The canonical task-create model field SHALL be an optional, trimmed, bounded
string that rejects empty values, control characters, and null bytes while
allowing punctuation used by aliases and provider-qualified model ids. An
explicit selector SHALL be validated against a current catalog resolved for the
same owner, runtime, credential, and environment as the task. A selector absent
from that catalog SHALL fail with `runtime_model_not_available`; failure to
obtain the catalog SHALL fail with `runtime_model_catalog_unavailable`. Both
failures SHALL occur before a Task row, schedule occurrence Task, or task-owned
execution sandbox is created, and any taskless catalog probe SHALL already be
reclaimed. Omitting `model` SHALL preserve the existing runtime-default behavior
and SHALL NOT make task creation depend on catalog availability.

#### Scenario: Explicit supported selector is accepted

- **WHEN** a caller supplies a syntactically safe selector present in the current effective catalog
- **THEN** validation returns that exact requested selector for persistence and launch

#### Scenario: Explicit unavailable selector fails before side effects

- **WHEN** a caller supplies a syntactically valid selector absent from the current effective catalog
- **THEN** the operation fails with `runtime_model_not_available`
- **AND** no Task row or task-owned execution sandbox is created, and any temporary catalog probe has been reclaimed

#### Scenario: Catalog failure fails an explicit selection closed

- **WHEN** a caller supplies an explicit selector but the effective catalog cannot be obtained
- **THEN** the operation fails with retryable `runtime_model_catalog_unavailable`
- **AND** no Task row or task-owned execution sandbox is created, and any temporary catalog probe has been reclaimed

#### Scenario: Omitted selector preserves today's default path

- **WHEN** a caller omits `model`, including while catalog discovery is unavailable
- **THEN** task creation follows the existing runtime/account default behavior without requiring a catalog lookup

### Requirement: Catalog validation and task launch share one immutable environment snapshot

The system SHALL resolve the effective provider source, content-addressed image
digest or provider-equivalent checksum, validated sandbox metadata, and runtime
CLI version into one immutable non-secret snapshot before catalog discovery for
an explicit model. The catalog probe SHALL use that snapshot, a newly created
Task SHALL persist it, and provisioning/recovery SHALL launch from it rather
than rereading a mutable tag or current deployment default. If CAP cannot bind
catalog and launch to an immutable provider identity, explicit model catalog and
validation SHALL fail closed without cross-request caching; model omission SHALL
retain the existing environment behavior.

#### Scenario: Mutable managed tag is pinned before discovery

- **WHEN** a managed environment source uses a mutable tag and its latest passed validation resolves digest `D`
- **THEN** catalog probing, cache fingerprint, persisted Task intent, and provisioning all use `D`
- **AND** retargeting the tag after preflight cannot change that Task's CLI/model context

#### Scenario: Deployment fallback gains an immutable snapshot

- **WHEN** explicit-null resolution selects a deployment fallback with no managed environment row
- **THEN** the shared resolver obtains a provider-specific immutable identity and CLI metadata for both catalog probing and Task provisioning

#### Scenario: Immutable identity cannot be established

- **WHEN** a selected environment can only be identified by a mutable reference and no provider-equivalent immutable snapshot can be obtained
- **THEN** an explicit-model query/create fails with safe catalog-unavailable semantics and no cross-request catalog entry
- **AND** no Task or task-owned execution sandbox is created and any resolution probe is reclaimed

#### Scenario: Admission recovery uses the persisted snapshot

- **WHEN** a Task with an explicit model is recovered after its environment tag or deployment default changed
- **THEN** provisioning uses the Task's persisted immutable environment snapshot and matching CLI version

### Requirement: Catalog caching is isolated by every availability boundary

Catalog caching SHALL be bounded and SHALL isolate entries by owner, runtime,
resolved immutable environment/image identity, effective CLI version,
credential revision, and model-policy revision. Expiry or a changed boundary
SHALL force refresh, and cached entries SHALL never cross owners or credential
contexts. The returned revision SHALL change when the effective ordered model
set or its validation-relevant metadata changes. CLI/provider discovery SHALL
run outside task idempotency transactions and schedule claim/write
transactions; those transactions SHALL consume only an already prepared local
validation result.

#### Scenario: Credential or environment changes invalidate reuse

- **WHEN** an owner's credential revision, model policy, resolved image identity, or effective CLI version changes
- **THEN** a catalog cached for the old context is not reused for validation in the new context

#### Scenario: Owners cannot share credential-aware cache entries

- **WHEN** two owners query the same runtime and sandbox environment
- **THEN** each query uses a cache partition bound to that owner's credential and policy context

#### Scenario: Discovery is not performed inside a write transaction

- **WHEN** task creation or a schedule occurrence requires explicit-model validation
- **THEN** any CLI subprocess, sandbox probe, or provider request completes before the idempotency or occurrence write transaction begins

### Requirement: Catalog probes are bounded taskless resources

The system SHALL run any environment-local CLI discovery through a dedicated
taskless catalog-probe lifecycle rather than normal Task admission. A probe MAY
create a short-lived provider sandbox for the resolved environment, but it SHALL
have global and per-owner concurrency bounds, fair queued scheduling, a bounded
queue/wait, absolute timeout, cancellation path, `finally` teardown, and orphan
reconciliation. One owner SHALL NOT monopolize all probe capacity. It SHALL never create a Task row or expose
a task terminal/session, and probe cleanup failure SHALL be observable to
operators without leaking credentials.

#### Scenario: Successful probe is reclaimed

- **WHEN** a Codex App Server probe returns a model catalog
- **THEN** its temporary provider resource is destroyed before the query completes and no Task or task-owned execution sandbox remains

#### Scenario: Failed or cancelled probe is reclaimed

- **WHEN** a probe times out, is cancelled, returns malformed output, or its adapter throws
- **THEN** teardown runs from a guaranteed cleanup path and the caller receives a safe catalog error

#### Scenario: Orphan probe is reconciled

- **WHEN** the API process exits after creating a catalog probe but before normal teardown
- **THEN** the bounded orphan reconciler identifies and destroys the taskless probe without affecting admitted Task sandboxes

#### Scenario: One owner cannot exhaust shared probe capacity

- **WHEN** one owner reaches its probe/queue allowance while another owner requests a catalog
- **THEN** fair scheduling preserves capacity for the other owner
- **AND** the over-limit request waits within a bound or receives safe retryable catalog-capacity data without creating a probe

### Requirement: Explicit model selection is fenced from legacy workers

The deployment SHALL keep a server-side `task-model-selection-v1` capability
gate closed until every live API, admission, scheduler, and runtime worker that
can write, claim, recover, or launch work is model-aware. On N workers, a closed
gate SHALL make catalog queries and new explicit-model task/schedule writes or
dispatches fail or remain unclaimed with safe retryable catalog-unavailable
semantics before model probing, Task persistence, or occurrence acceptance;
omitted-model task behavior SHALL remain unchanged.

An N gate SHALL NOT be treated as protection for an N-1 writer whose raw REST
or MCP schema may strip an unknown direct or nested `model`. Before any
model-aware contract/client is published or allowed to send traffic, the first
release SHALL close task/schedule write ingress, disable MCP writers, and stop
or fully remove every N-1 API/admission/scheduler/runtime worker in a mandatory
maintenance cutover. Only after every remaining role reports the capability may
the gate and write ingress open. Mixed-version serving enablement is outside
this change.

Closing the gate SHALL stop new explicit-model admission but SHALL NOT make a
model-aware worker ignore already persisted intent. Such a worker SHALL keep
using the persisted selector and immutable environment snapshot or fail closed.
Before runtime support is rolled back, every enabled explicit-model schedule
SHALL be paused and every non-terminal explicit-model Task and retrying
occurrence SHALL be drained, explicitly cancelled, or terminally resolved. A
rollback preflight SHALL block downgrade while any such work remains.

#### Scenario: Mixed-version deployment keeps the feature closed

- **WHEN** any N-1 writer or claimer that does not report `task-model-selection-v1` is still live
- **THEN** external task/schedule write ingress and MCP writing are closed before any model-aware client or schema is exposed
- **AND** the deployment does not claim that an N-only feature gate can prevent N-1 unknown-field stripping

#### Scenario: Capability-verified cutover enables all writers together

- **WHEN** the database migration is complete, write ingress is closed, every N-1 worker has stopped, every remaining API/admission/scheduler/runtime role reports `task-model-selection-v1`, and compatibility checks pass
- **THEN** the deployment may open the N server gate and write ingress coherently and only then expose catalog, task, and schedule model contracts

#### Scenario: N-1 stripping hazard is contained by routing

- **WHEN** compatibility verification proves an isolated N-1 REST or MCP writer strips an unknown direct or nested `model` field
- **THEN** the release cutover prevents model-aware traffic from routing to that writer rather than expecting it to fail closed

#### Scenario: Closing admission does not corrupt accepted intent

- **WHEN** the gate closes while a model-aware worker is draining an already accepted explicit-model Task
- **THEN** recovery and launch still use the persisted selector and immutable environment snapshot
- **AND** no runtime-default fallback is introduced by the closed gate

#### Scenario: Unsafe rollback is blocked

- **WHEN** rollback preflight finds a non-terminal explicit-model Task, an enabled explicit-model schedule, or a retrying explicit-model occurrence
- **THEN** removal of model-aware runtime workers is blocked until that work is safely drained, paused, cancelled, or terminally resolved
