# Task provisioning diagnostics operations guide

Task provisioning diagnostics preserve a bounded, secret-free explanation of
what happened while CAP selected a provider, created a sandbox, materialized a
workspace, prepared the runtime, launched the agent, and reconciled cleanup.
They supplement task status, lifecycle audit, and operational logs; they do not
replace any of those sources or the admission authority.

The feature is default-closed. Diagnostic writes have their own switch, while
reads and new `tasks:diagnostics` credential grants share a deployment-wide
capability gate.

## Contract and retention

The current wire and storage contract is `schemaVersion = 1`.

| Bound | Value | Meaning |
| --- | ---: | --- |
| Events per attempt | 64 | One logical operation retains at most one start and one terminal/degraded event. Poll ticks, attach frames, and output chunks are not events. |
| Detailed attempts per response | 8 | Older terminal detail may be folded into the typed `compaction` summary. |
| Default event page | 50 | Used when `limit` is omitted. |
| Maximum event page | 200 | Larger requests fail validation. |

Attempts are numbered monotonically for one task. CAP-generated `attemptId`,
`eventId`, and `operationId` correlate durable rows and structured stdout; a
provider-native sandbox or execution id is never used for that purpose. Event
sequence and operation-phase idempotency make retry and replay writes stable.

Diagnostic detail follows the owning task's retention boundary and survives API
restart and log rotation. It is not copied event-for-event into lifecycle audit.
Task deletion or the configured task-retention policy removes the remaining
task-owned ledger. Emergency rollback leaves the additive tables in place; it
does not run a destructive down migration.

## Coverage vocabulary

Treat `coverage` as evidence quality, not as task outcome.

| Coverage | Operator interpretation |
| --- | --- |
| `not_started` | Work was accepted or queued, but no provisioning attempt opened yet. Empty events are expected. |
| `partial` | Some evidence exists, but a write failed, a sequence/lifecycle is incomplete, an attempt was interrupted, detail was truncated/compacted, an event version is unsupported, or cleanup is still pending. Do not infer missing facts. |
| `complete` | A terminal attempt has an explicit durable completeness marker, valid operation/sequence invariants, and cleanup is not pending. Absence of a visible gap alone never proves this state. |
| `unavailable` | The task predates the diagnostic expectation/ledger or no trustworthy diagnostic coverage can be established. CAP does not reconstruct evidence from logs or audit prose. |

Attempt `state` (`active`, `succeeded`, `failed`, `cancelled`, or
`interrupted`) and its `primary` result describe provisioning. The independent
`cleanup.state` (`not_required`, `pending`, `succeeded`, or `failed`) describes
physical cleanup and durable authority. A cleanup failure never overwrites the
primary runtime or workspace failure.

`channel` separates `primary`, `cleanup`, and orchestration `coordination`
evidence. In particular, `cleanup = pending` on a durable attempt means the
cleanup owner, lease, and concurrency slot must remain authoritative until
confirmed absence/removal or terminal cleanup policy settles them.

## Safe and forbidden data

The diagnostic envelope is a strict discriminated union. It may contain only:

- Versioned CAP identities and ordering: `schemaVersion`, `taskId`, `attemptId`,
  attempt number, `eventId`, `operationId`, idempotency key, sequence, and
  observation time.
- Closed classifications: admission mode, provider family, stage, operation,
  channel, command kind, outcome, safe cause, native state, anomaly, and HTTP
  status class.
- Bounded facts: duration, timeout, nullable numeric exit code, and
  retryability.

It must never contain command/argv text, cwd or any filesystem/credential path,
prompt, stdout/stderr/output, environment/configuration dumps, raw error message,
cause or stack, request/response body, HTTP or WebSocket headers, token,
credential-bearing URL, endpoint/connection URL, lease owner identity, account
or repository identity, or provider-native sandbox/resource/execution id.

Existing internal sandbox ownership columns may retain the exact provider
resource id required for fenced cleanup. That exception does not extend to the
diagnostic database, stdout envelope, metrics, REST, MCP, OpenAPI, Playground,
or Console. Strict validation rejects an undeclared field before persistence or
logging; logger redaction is only defense in depth.

## Authorization and transport behavior

Ordinary task create/list/get/stop responses remain unchanged and never embed
this ledger.

- Public V1: `GET /v1/tasks/{id}/provisioning-diagnostics` requires an
  account-owned API key carrying `tasks:diagnostics`. It is owner-only; there is
  no Public V1 administrator exception.
- MCP: `get_task_provisioning_diagnostics` requires the same explicit scope and
  owner. Its `structuredContent` is the canonical response object, and its text
  content is the JSON serialization of that same value. The operation registry
  declares no REST/MCP semantic difference.
- Console: `GET /tasks/{id}/provisioning-diagnostics` accepts only an
  authenticated human session. A member may read their own task. A currently
  enabled administrator, rechecked from the live User row for every request,
  may read cross-owner and ownerless historical tasks.

An identity-less principal cannot use the Public V1/MCP operation. An ownerless
task is non-enumerating/not-found on those transports. `tasks:read` does not
imply `tasks:diagnostics`, and credentials minted before this scope existed gain
no access automatically.

Both REST and MCP accept `id`, optional `limit`, and optional opaque `cursor`.
Continue with `nextCursor` until it is `null`; never inspect or construct cursor
contents in an integration.

## Deployment gates and staged enablement

Diagnostic writes are independent of admission-v2:

```dotenv
CAP_TASK_PROVISIONING_DIAGNOSTICS_WRITES_ENABLED=false
```

Reads and new diagnostic-scope grants require both values below on every API
serving instance:

```dotenv
CAP_TASK_PROVISIONING_DIAGNOSTICS_READS_ENABLED=false
CAP_TASK_PROVISIONING_DIAGNOSTICS_ATTESTATION_JSON=
```

The attestation is supplied by the deployment controller and expires. Its
`expectedWorkers` membership must include every API/MCP/Web serving role, and
every expected instance-role pair must report all five compatibility facts:

- `task-provisioning-diagnostics-schema-v1`
- `task-provisioning-diagnostics-owner-required-v1`
- `task-provisioning-diagnostics-scope-parser-v1`
- `task-provisioning-diagnostics-registry-v1`
- `task-provisioning-diagnostics-wire-fixture-v1`

All reports must be ready, current, expected, and use one build identity. For
the API process, the attested instance id must equal `CAP_INSTANCE_ID` (or its
runtime hostname fallback), and build identity must equal `GIT_SHA` or
`CAP_VERSION`. Invalid, missing, future, expired, mixed-build, incomplete, or
unexpected evidence closes the gate. Closed reads return retryable
`task_provisioning_diagnostics_unavailable`; no database evidence is returned,
and API-key/MCP-token minting that requests `tasks:diagnostics` is rejected.

Use this rollout order:

1. Apply the additive migration and deploy schema/reader code with writes and
   reads closed. Existing task and MCP/API operations must remain healthy.
2. Deploy compatible sandbox-core/providers, Guardrails/admission, logger,
   metrics, API/MCP, and Web code to every serving role. Run migration,
   provider-conformance, wire-compatibility, public-surface, and secret-canary
   gates.
3. Enable writes only. Exercise one success, representative controlled
   failures, a cleanup failure, and a disconnected create request in both
   applicable admission modes. Check bounded rows, event correlation, and zero
   secret matches.
4. Assemble a fresh complete attestation, enable reads, and confirm REST, MCP,
   Console, OpenAPI, and Playground parity. Only then allow operators to mint
   credentials with `tasks:diagnostics`.
5. Roll out admission-v2 separately under its own attestation and authority.
   Changing the diagnostics gates must not enable, disable, or bypass
   `TaskAdmissionWork`, durable leases, or SandboxRun ownership.

## Credential grant timing

`tasks:diagnostics` is opt-in and is intentionally absent from fresh API-key and
MCP-token defaults. Grant it only after the read gate is confirmed open on the
complete deployment, and only to a trusted diagnostic client that also has the
correct task owner identity. A client needs `tasks:read` separately if it must
perform ordinary task reads.

The raw `cap_sk_` or `mcp_` value is shown once. Record its owner, purpose, and
expiry outside CAP without copying diagnostic output or credentials into logs.
Revocation remains the Settings API Keys/MCP Server operation and takes effect
on the next credential resolution.

## Operator investigation flow

1. Read the ordinary task first. Record task status and safe provisioning stage;
   do not assume `creating` means no provider work occurred.
2. Use the Console panel, Public V1 endpoint, or MCP tool with the owner and
   explicit diagnostic scope. If the gate returns unavailable, fix deployment
   compatibility instead of bypassing it with database or raw-provider output.
3. Read top-level `coverage` and `admissionState`. `not_started` distinguishes
   queued/unclaimed work; `partial` limits every later conclusion.
4. Inspect attempts from their monotonic number. Compare the terminal `primary`
   and independent `cleanup` summary before looking at individual events.
5. Follow each `operationId` from one `started` event to its one terminal or
   degraded event. Use `stage`, `operation`, `outcome`, safe `cause`,
   `retryable`, `exitCode`, and anomaly; never search for raw command output.
6. If ephemeral logs remain, join the structured
   `task_provisioning_diagnostic_event` record by `eventId`, `attemptId`, and
   `operationId`. Timestamp or free-form message matching is unnecessary.
7. Check `GET /metrics` for fleet-wide pattern and cleanup pressure, then use
   task evidence for the individual incident. Lifecycle audit remains the
   source for product milestones, not provider-operation detail.

## Metrics interpretation

The optional `provisioningDiagnostics` block on the session-authenticated
metrics response is low-cardinality:

- `observedSince` is the process-window start for counters. After restart, do
  not compare those counters as lifetime totals.
- `attemptOutcomes`, `stageOutcomes`, `retries`, `cleanupOutcomes`, and
  `anomalies` use closed provider/stage/outcome/cause tuples and bounded
  count/sum/max duration summaries. They contain no task or resource labels.
- `durableGauges` is rebuilt from persistent state. `available` is fresh,
  `stale` includes the retained sample and age, and `unavailable` uses `null`
  rather than fabricated zeros. Watch `activeAttempts`,
  `oldestActiveAttemptAgeMs`, `cleanupPendingRuns`, and
  `confirmedOrphanRuns` together.

Metric degradation affects only this additive block; established capacity,
occupancy, runner-minute, and sampled-resource blocks retain their own
availability semantics.

## Gate-first rollback and revocation

Rollback in this order:

1. Set `CAP_TASK_PROVISIONING_DIAGNOSTICS_READS_ENABLED=false` everywhere (or
   withdraw/expire the attestation) and verify REST/MCP/Console reads and new
   diagnostic-scope grants fail closed.
2. Revoke every API key and MCP token carrying `tasks:diagnostics` before any
   version whose scope parser does not recognize that value is deployed.
3. Set `CAP_TASK_PROVISIONING_DIAGNOSTICS_WRITES_ENABLED=false`. Let in-flight
   provisioning boundaries settle; do not change admission-v2 ownership or
   release durable slots merely to accelerate rollback.
4. Roll back application components only after ordinary task paths remain
   healthy. Leave additive diagnostic tables/rows in place for a later cleanup
   release.

This sequence prevents a mixed deployment from reading evidence or granting a
scope that an older process cannot authorize safely.
