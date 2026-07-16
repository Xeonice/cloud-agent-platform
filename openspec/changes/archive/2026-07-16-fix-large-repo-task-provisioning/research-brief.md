# Research brief: reliable large-repository task provisioning

## Incident evidence

The production investigation reproduced the failing repository in disposable
BoxLite sandboxes without creating a CAP task and reclaimed every probe
sandbox afterward.

| Probe | Result |
| --- | --- |
| Existing default BoxLite disk | Root filesystem had about 412 MiB free. Forge authentication, TLS, and refs lookup succeeded, then pack transfer failed after about 242 seconds with `No space left on device`. |
| Native BoxLite `disk_size_gb: 5` | The sandbox root filesystem grew to about 5 GiB and exposed about 3.8 GiB free before cloning. |
| Same repository on the 5 GiB sandbox | Pack transfer completed in about 321 seconds; checkout completed; the resulting worktree consumed about 1.7 GiB. |
| Repository metadata | Remote symbolic HEAD resolved to `master`; `main` did not exist. The CAP repo row had a null `defaultBranch`, while the Console fabricated `main`. |
| Create request | `POST /repos/:repoId/tasks` waited about 124 seconds and returned only after provisioning had already failed, because the task-create call awaited admission and admission awaited the provider. |

This proves the primary clone failure was insufficient sandbox storage, not a
missing Gitee token, bad URL, TLS failure, proxy bypass, or missing `gcode`.
It also proves that merely increasing storage is insufficient: the successful
pack transfer exceeded the current 120-second workspace command budget.

## Current code and contract seams

- The native BoxLite create request sends image/rootfs and environment values,
  but not `disk_size_gb`; BoxLite configuration exposes only a generic client
  timeout and no workspace-clone deadline.
- BoxLite workspace materialization builds one `sh -lc` command containing
  `git -c http.extraHeader=... clone --recursive`. The credential can therefore
  appear in an observable command/request payload and the unscoped header may
  be inherited by recursive submodules on other hosts.
- Console, Public V1, and MCP share task contracts and services, but the real
  `TasksService.create` path awaits `admitCreatedTask`, which in turn awaits
  sandbox provisioning. Existing MCP text and specification already promise an
  immediate task handle; current integration tests use fakes that do not expose
  real provisioning latency.
- URL/GitLab/Gitee repo import is Console/Internal-only and currently lacks an
  authenticated owner seam, so it cannot use the owner's stored forge
  credential to validate a private URL or resolve its default branch. Public V1
  and MCP expose only repo reads.
- Sandbox-environment administration is also Internal-only. Public task writers
  select an environment by UUID (or use the existing absent/null fallback
  semantics); they do not administer provider resources.
- Task responses already contain an optional structured failure union, but
  provisioning currently collapses to a generic internal `provision_failed`
  reason. Operators cannot distinguish capacity, timeout, authentication,
  missing-ref, network, or unknown workspace failures from durable task data.

## Existing capability anchors

The change should modify existing capabilities rather than introduce a broad
new umbrella capability:

- `sandbox-environments`: immutable provider-aware provisioning metadata.
- `sandbox-provider-port`: provider-neutral provision and workspace contracts.
- `boxlite-sandbox-provider`: native BoxLite creation and workspace behavior.
- `multi-forge-repo-import`: forge-aware URL import.
- `repo-and-task-management`: repo metadata, task persistence, branch intent,
  and task-create lifecycle.
- `task-result-delivery`: clone/push credential transport.
- `guardrails`: admission, concurrency, and startup recovery.
- `public-v1-api`: shared task create and V1 idempotency behavior.
- `frontend-console`: repo import and create-task interaction.
- `audit-history`: durable, diagnosable task failure history.

The existing `mcp-server` immediate-return requirement, observability redaction
requirements, and API/MCP parity requirements remain acceptance baselines; they
do not need duplicate requirements.

## Recommended correction flow

1. Resolve a non-secret provisioning policy before provider selection. Add a
   dedicated sandbox-environment resource field for storage, plus a BoxLite
   deployment fallback. Validate bounds and provider support, snapshot the
   resolved value, and send it as native `disk_size_gb` on both validation and
   task sandboxes. Do not put control-plane resource values in runtime image
   parameters.
2. Resolve clone intent deterministically: explicit task branch, then persisted
   repo default branch, then a credentialed remote symbolic-HEAD lookup; never
   fabricate `main`. URL import becomes owner-aware and persists the discovered
   default branch. A missing or inaccessible branch becomes a structured
   background provisioning failure rather than a synchronous create hang.
3. Replace raw header interpolation with a provider-neutral, secret-aware
   workspace credential channel. Materialize a mode-0600, exact-host-scoped
   temporary Git config through a redacted secret-write primitive; commands
   contain only its path. Remove it after clone/push and before retention. A
   different-host submodule must not inherit the parent forge credential.
4. Give workspace materialization its own bounded deadline, separate from the
   BoxLite control-plane request timeout. Preserve full selected-branch history
   while avoiding unrelated branches; do not introduce shallow history because
   agent and delivery workflows may require merge bases. Record safe stages and
   classified causes without persisting raw authenticated commands or tokens.
5. Commit the task row, V1 idempotency record when applicable, and a unique
   durable admission work item atomically. Return the initial task immediately.
   A lease-based background worker performs guardrails admission/provisioning;
   retries and startup recovery re-drive unfinished work without duplicating a
   task or sandbox. Stop/cancel wins over a late worker.
6. Project a secret-free provisioning stage and stable failure reason through
   canonical task reads. Console navigates as soon as it receives the task id,
   then renders polling/SSE progress and actionable failures. Public V1, MCP,
   OpenAPI, and Playground retain their registry-derived parity.

## Surface decision

- Public V1 changes only existing task operations and repo reads. There is no
  new repo-import or sandbox-environment administration operation.
- MCP changes the matching task/repo tools and continues to exclude repo writes
  and environment administration. `create_task` must be proven non-blocking
  against the real task service, not just a fake adapter.
- OpenAPI and API Playground derive the affected operation descriptions and
  additive provisioning/failure response schemas from the public registry.
- Console/Internal changes cover owner-aware URL import, environment resources,
  the admission worker, provider plumbing, and create-task UX.

## Verification strategy

Verification must exercise production seams rather than hardcode the incident
repository or manufacture passing responses:

1. Unit and contract tests cover resource bounds/precedence, absent-null-UUID
   environment semantics, branch precedence, failure classification, secret
   redaction, and the exact-host credential policy.
2. Provider conformance tests assert native `disk_size_gb`, independent clone
   deadlines, secret-free command argv/payloads, cross-host submodule isolation,
   cleanup, and typed capacity/timeout/auth/ref/network failures.
3. Database/integration tests simulate response disconnect and process restart
   around every transaction/lease boundary and prove one task, one admission
   work item, at most one live sandbox, eventual recovery, and cancellation
   fencing.
4. Real-service latency tests hold provisioning behind a controllable promise
   and prove Console REST, Public V1, and MCP all return the same initial task
   before that promise settles; polling then observes stage and terminal cause.
5. Registry/OpenAPI/Playground tests cover `tasks.create/list/get/stop` and
   `repos.list/get`, their MCP mappings, structured responses, and declared
   internal-only exclusions.
6. A gated local BoxLite story creates a disposable sandbox with the resolved
   disk, clones a generated large private-repo fixture whose transfer exceeds
   the old 120-second boundary, checks out a non-`main` default branch, and
   verifies cleanup. Production smoke repeats this with an operator-selected
   repository and records timings/free space without printing credentials.

## Non-goals

- No new Public V1/MCP repo-write scope or import tool in this change.
- No public sandbox-environment administration API.
- No credential-bearing clone URLs, process-global git config, or token-bearing
  command/environment values.
- No shallow clone guarantee, repository-specific hardcoded branch, fixed test
  sleeps, or special case for the incident repository.
