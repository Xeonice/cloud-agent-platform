## Why

Large private repositories can currently fail after task creation because BoxLite ignores required disk capacity, workspace clone shares an undersized timeout, and repository branch metadata may be fabricated as `main`. Since the create request synchronously waits for provisioning, these failures also leave the Console apparently stuck and violate the existing MCP promise to return a task handle immediately.

## What Changes

- Add validated, provider-aware sandbox storage requirements and pass the resolved value to native BoxLite `disk_size_gb` for both validation probes and task sandboxes.
- Make workspace materialization branch-deterministic and independently time-bounded; persist the authenticated remote default branch and never invent `main` when no branch is known.
- Replace token-bearing git command arguments with an exact-host-scoped, mode-0600 ephemeral credential channel that is removed after clone/push and before retention.
- Atomically persist a task and unique admission work item, return the initial task immediately, and perform idempotent guardrails admission/provisioning in a lease-based recoverable background worker.
- Persist and expose secret-free provisioning stages and stable capacity/timeout/auth/ref/network failure reasons so Console, Public V1, and MCP clients can distinguish an active clone from an actionable terminal failure.
- Make Console URL import owner-aware, navigate as soon as task creation returns an id, and render subsequent provisioning progress through polling/SSE.
- Extend real-service, provider-conformance, restart-boundary, public-surface, and gated BoxLite verification so the behavior is proven without repository-specific branches, fixed sleeps, or hardcoded successful responses.
- Keep repo import and sandbox-environment administration Console/Internal-only; no new Public V1 operation, MCP tool, or repo-write scope is introduced.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `sandbox-environments`: Carry validated storage requirements in immutable provider-aware provisioning metadata without treating them as runtime image parameters.
- `sandbox-provider-port`: Carry resolved resources, branch intent, a secret-aware git credential descriptor, independent workspace deadlines, and typed materialization failures through provider-neutral contracts.
- `boxlite-sandbox-provider`: Map resolved storage to native BoxLite creation and provide bounded, observable, secret-safe git materialization and cleanup.
- `multi-forge-repo-import`: Make URL import owner-aware and persist a forge-correct remote default branch after credentialed validation.
- `repo-and-task-management`: Resolve branches without a fabricated default, durably accept tasks before asynchronous admission, and expose safe provisioning state/failure data.
- `task-result-delivery`: Replace raw `http.extraHeader` command interpolation with an ephemeral, exact-host-scoped credential transport for clone and push.
- `guardrails`: Admit durable pending work idempotently and recover unfinished admission after a process restart while respecting cancellation and concurrency.
- `public-v1-api`: Return the committed initial task without waiting for provisioning and keep idempotency atomic with durable admission.
- `frontend-console`: Use persisted default branches, return from the create dialog on durable acceptance, and render provisioning progress/failure instead of an indefinite creating state.
- `audit-history`: Record safe, structured provisioning stages and causes while excluding credentials and raw authenticated commands.

## Impact

Affected areas include sandbox-environment contracts and persistence, the sandbox provider port, BoxLite client/config/workspace code, forge credential and repo import services, task/admission/guardrails persistence and recovery, canonical task failure schemas, Console task forms and task detail UI, the Public V1 registry and MCP adapter behavior, generated OpenAPI/Playground projections, deployment defaults/documentation, and end-to-end BoxLite verification. Existing task-create request fields and repo/environment administration exposure remain backward compatible; task responses gain additive provisioning/failure variants and create calls return substantially sooner.
