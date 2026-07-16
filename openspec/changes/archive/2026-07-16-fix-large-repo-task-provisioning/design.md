## Context

The production failure was a chain of independent defects rather than a Gitee
authentication failure. The stored owner credential could resolve refs and TLS
completed, but the default BoxLite root disk had only about 412 MiB free. Pack
transfer exhausted the disk, while a 5 GiB disposable sandbox completed the
same transfer in about 321 seconds—well beyond the current 120-second command
budget. The repository's symbolic HEAD was `master`, but the repo row had no
default branch and the Console substituted `main`. Finally, every task-create
surface awaited the same synchronous admission/provisioning call, so the HTTP
request remained open until the failure.

The correction crosses contracts, persistence, task admission, provider ports,
BoxLite native REST, forge credential handling, repo import, Console UX, Public
V1, MCP, OpenAPI, and the API Playground. It must preserve existing owner
isolation, task idempotency, environment absent/null/UUID semantics, guardrails
concurrency, and result delivery while ensuring no forge secret is copied into
an observable command line or retained sandbox.

## Goals / Non-Goals

**Goals:**

- Provision enough BoxLite storage from a validated, auditable policy and give
  git workspace operations a separate bounded deadline.
- Resolve a real branch deterministically and preserve explicit task intent
  without fabricating `main` or mutating the existing nullable `Task.branch`.
- Transport clone/push credentials through an exact-host-scoped ephemeral
  secret channel rather than shell arguments, URLs, environment values, or
  retained configuration.
- Return a committed initial task promptly from Console REST, Public V1, and
  MCP, then perform admission durably and idempotently in the background.
- Expose safe progress and actionable capacity/timeout/auth/ref/network failure
  categories through canonical task reads and audit history.
- Prove behavior at the real service/provider seams, including crash recovery,
  public-surface parity, a non-`main` branch, and a clone exceeding the old
  timeout.

**Non-Goals:**

- Adding Public V1/MCP repo import, a `repos:write` scope, or public sandbox
  environment administration.
- Putting disk size or clone deadline into the public create-task body.
- Shallow-cloning repository history or introducing repository-specific logic.
- Exposing raw git output, authenticated commands, tokens, native sandbox
  connection details, or internal retry leases on public task responses.
- Replacing the existing guardrails concurrency policy or adding a second task
  creation domain path.

## Decisions

### 1. Resource policy belongs to the resolved sandbox environment

Add a dedicated, non-secret `resources` object to managed sandbox environments,
initially supporting a validated positive integer `diskSizeGb`. It is separate
from image `parameters`: parameters are guest runtime values injected after
workspace materialization, while resources control sandbox creation before a
guest exists. The environment resolver produces an immutable resource snapshot
alongside image/rootfs identity and validation evidence.

For BoxLite, resolution precedence is:

1. the selected managed environment's explicit `resources.diskSizeGb`;
2. the deployment-level `BOXLITE_DISK_SIZE_GB`;
3. the CAP BoxLite default shipped by deployment assets.

The same resolved value is used by image-validation probes and task sandboxes
and is sent to native BoxLite as `disk_size_gb`. Provider capability metadata
and environment validation reject an explicit resource a provider cannot
enforce. Legacy environments without a resource remain valid and use the
deployment fallback. The resolved value, not the mutable default, is stored in
secret-free sandbox run metadata.

Alternative considered: only increase a global BoxLite default. That repairs
one host but cannot express larger environments, cannot prove validation/task
parity, and makes a later config change silently alter recovered work.

### 2. Clone timeout is an operation policy, not a control-plane timeout

Introduce `BOXLITE_GIT_CLONE_TIMEOUT_MS` (with validated deployment bounds) as
the workspace materialization deadline. Keep `BOXLITE_TIMEOUT_MS` for short
native BoxLite control-plane requests. The initial deployment default for clone
materialization is 15 minutes, providing margin over the observed 321-second
pack transfer without making hangs unbounded.

Materialization is an ordered state machine rather than one compound shell
command: credential setup, remote-ref resolution, fetch/clone, checkout,
submodules, and cleanup. Each stage reports a typed result and the overall
deadline cancels outstanding execution. The implementation may combine stages
when a provider has a structured primitive, but the observable stage/error
contract remains stable.

Alternative considered: raise the generic BoxLite client timeout. That would
also lengthen health, create, inspect, and teardown failures, and still would
not distinguish a slow clone from an unhealthy control plane.

### 3. Branch intent and resolved branch remain distinct facts

`Task.branch` continues to mean exactly what the caller supplied and remains
nullable when omitted. A separate immutable provisioning value records the
resolved branch. Resolution order is:

1. an explicit task branch;
2. the persisted `Repo.defaultBranch`;
3. an authenticated `ls-remote --symref ... HEAD` result for a legacy repo;
4. a typed `branch_not_found` provisioning failure.

URL/GitLab/Gitee import receives the authenticated account id, resolves the
owner-scoped credential for the exact forge host, validates access, reads the
remote symbolic HEAD, and persists it before the repo becomes selectable.
Picker imports persist the forge API's default branch. Legacy null rows are
resolved lazily by the task owner and may be safely backfilled after the probe;
there is no unauthenticated bulk migration. The clone fetches the selected
branch only but retains its full history; it does not use `--depth`.

Alternative considered: defaulting to `main` or letting plain `git clone` pick a
branch. The first is incorrect for the incident repository; the second makes
the checkout and later PR base implicit and prevents CAP from reporting the
resolved intent.

### 4. Git authentication uses a provider-neutral secret writer

Replace the raw `authHeader`-in-command contract with a typed workspace
credential descriptor containing the exact scheme/host and secret header. The
descriptor is resolved only from the task owner's forge credential and is
consumed only inside the selected provider. A new secret-write primitive
creates a mode-0600 temporary git config without interpolating its content into
the executed command, argv, environment, connection metadata, or normal logs.
The config uses an exact-host URL subsection, so a different-host submodule
does not inherit the parent token. Git commands receive only the temporary path.

Clone and push use the same mechanism. Cleanup runs in `finally`, before
retention, and is idempotent. Secret-write and cleanup events are redacted; raw
git diagnostics are scrubbed before structured logging and are never persisted
in task/audit response fields.

Alternative considered: keep `git -c http.extraHeader=...`. Although it avoids
credential-bearing URLs, it still places the token in the guest command and
BoxLite exec request, and its unqualified scope can reach recursive submodules.

### 5. The Task row and admission outbox form the durable acceptance boundary

Create a `TaskAdmissionWork` record with a unique `taskId`, state, attempt,
availability time, lease owner/expiry, safe stage/cause, and timestamps. The
Task row, admission work item, V1 idempotency record when present, and an
idempotent creation-audit identity are committed atomically after existing
synchronous request validation and model/environment preparation. The create
handler then returns the canonical initial Task; it never awaits provider
selection, sandbox creation, clone, runtime setup, or agent launch.

A background admission worker claims available rows with a database lease,
re-reads task state and immutable inputs, and invokes the existing guardrails
admission path. A local wake-up signal reduces latency, while database polling
is the durable floor. The worker records stage progress, renews its lease during
long operations, classifies failures, and either completes, schedules a bounded
retry for retryable infrastructure failures, or terminalizes the task. Provider
provision remains idempotent by task id, making a crash after sandbox creation
safe to replay. A cancellation/status version check before and after every
external boundary ensures stop wins and a late worker tears down any superseded
sandbox.

Scheduled tasks also use this canonical write/outbox seam. MCP creates remain
distinct calls because MCP has no HTTP `Idempotency-Key`; Public V1 replay
returns the original Task and never inserts a second outbox row.

Alternative considered: `void admitCreatedTask(...)` after sending the
response. That is fast but loses work on process exit and provides no lease,
retry, or exactly-once acceptance boundary.

### 6. Provisioning state is a safe public projection

Canonical Task responses gain an optional nullable `provisioning` summary for
legacy compatibility. It includes only a stable state, stage, attempt count,
resolved branch when known, and update timestamp. Internal lease identity,
provider endpoints, native sandbox ids, and diagnostic output are excluded.

The existing `failure` union gains structured provisioning variants for at
least capacity exhaustion, clone timeout, forge authentication, TLS/network,
missing branch/ref, and an unknown fallback. Each variant has a stable action
and safe message; classification never depends on a test-only response or
persists a token-bearing command. `tasks.create/list/get/stop` and their MCP
mappings use the same schema. `repos.list/get` already expose nullable
`defaultBranch`; this change supplies the real value. OpenAPI and Playground
derive these changes from the public registry.

Alternative considered: only improve server logs. Logs helped diagnose this
incident but do not let the creating client distinguish a five-minute active
clone from a completed failure, and they may not survive retention.

### 7. Console exits the create state at durable acceptance

Both create-task entry points use the same mutation. They omit branch when no
real default is known, submit once, close/navigate immediately on the returned
task id, and let the task page poll/SSE the canonical provisioning projection.
The UI renders stage-specific progress and actionable failure text; it does not
keep the modal spinner tied to clone duration. Import flows show access/default
branch probe failures before saving a repo.

### 8. Verification uses generated fixtures and controllable boundaries

Tests call production schemas, services, classifiers, and provider adapters.
Large-repo coverage uses a generated private git fixture with enough data and a
throttled/controlled executor to cross the old deadline deterministically; it
does not depend on the incident repository or fixed sleeps. A gated local
BoxLite story additionally exercises native disk creation and real git. Public
surface verification runs the shared registry, V1, MCP, OpenAPI, and Playground
gates plus a real-service nonblocking create test.

## Risks / Trade-offs

- **[Disk defaults consume more host capacity]** → Keep the value configurable,
  validate host/provider bounds, expose the resolved value, and retain existing
  cleanup/low-disk policies; deployment preflight warns when aggregate capacity
  cannot support configured concurrency.
- **[Long clone leases expire during a healthy transfer]** → Renew leases from
  stage/heartbeat events and make replay idempotent by task id; use a lease
  duration independent from the clone deadline.
- **[Failure text differs across git/forge versions]** → Prefer structured
  timeout/exit/disk signals and narrowly classify known stable evidence; fall
  back to a safe unknown code rather than guessing.
- **[A token could leak through a new executor/logger]** → Make secret writing a
  distinct redacted port, prohibit secrets in command/env types, add canary
  secret tests across argv, logs, audit rows, run metadata, and retained files,
  and fail cleanup closed before retention.
- **[Rolling deploy mixes synchronous and asynchronous workers]** → Add an
  advertised admission-v2 role capability and keep the write gate closed until
  all API/worker roles report support. Old optional response fields remain
  readable throughout rollout.
- **[Legacy repos have no default branch]** → Resolve lazily with the current
  task owner's exact-host credential; fail with an actionable branch/access
  cause rather than fabricating a value.
- **[Single-branch fetch changes unusual workflows]** → Preserve full selected
  branch history and fetch explicit additional refs only when delivery needs
  them; retain a conformance fixture for PR merge-base behavior.

## Migration Plan

1. Ship additive database columns/tables, contracts, resource parsing, secret
   port, provider support, and the admission worker with the admission-v2 gate
   disabled. Existing synchronous creation remains active.
2. Configure deployment assets with reviewed BoxLite disk and clone-timeout
   defaults. Run readiness against a disposable sandbox and verify available
   host capacity for the configured concurrency ceiling.
3. Deploy every API/worker role, verify capability reporting, provider
   conformance, secret canaries, and the public compatibility fixture, then open
   the gate so new task writes create admission work and return immediately.
4. Allow legacy null-branch repos to backfill only through an authenticated
   owner action; do not run a tokenless global migration.
5. Run a gated BoxLite task through Console REST, Public V1, and MCP, observe
   durable stage progress, complete/stop it, and verify no probe boxes or secret
   files remain.

Rollback first closes the admission-v2 write gate, lets the compatible worker
drain already-accepted work, and only then rolls application code back. Additive
database structures and nullable response fields remain in place until a later
cleanup release; destructive down-migration is not part of emergency rollback.

## Open Questions

None blocking. The concrete deployment disk default and maximum concurrency
remain operator-reviewed values, but their precedence, validation, propagation,
and verification are fixed by this design.
