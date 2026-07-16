# Durable task admission v2: staged cutover and drain-first rollback

Task admission v2 commits a Task and one durable admission-work row before it
returns to Console REST, Public V1, or MCP. Provisioning then runs in a leased,
restart-recoverable worker. The database changes are additive, but opening the
new write path during a mixed-version rollout is unsafe: an older writer does
not create the durable work row and an older worker does not understand its
lease/recovery contract.

Keep `CAP_TASK_ADMISSION_V2_ENABLED=false` until every step below succeeds. The
boolean alone never opens the gate. CAP also requires a complete, unexpired
`CAP_TASK_ADMISSION_V2_ATTESTATION_JSON` covering every expected API/worker
instance.

## BoxLite policy that must be reviewed first

The release assets and quick-deploy path use these defaults:

| Variable | Default | Accepted range | Purpose |
| --- | ---: | ---: | --- |
| `BOXLITE_DISK_SIZE_GB` | `5` | integer `1..1024` | Deployment fallback root-disk capacity. |
| `BOXLITE_GIT_CLONE_TIMEOUT_MS` | `900000` | integer `1000..86400000` | End-to-end Git workspace materialization deadline. |
| `BOXLITE_TIMEOUT_MS` | `30000` | positive integer | Short BoxLite control-plane requests only; it is not the clone deadline. |

Disk capacity is resolved once per validation probe or task, in this order:

1. `resources.diskSizeGb` on the selected managed sandbox environment;
2. the validated deployment value `BOXLITE_DISK_SIZE_GB`;
3. CAP's packaged `5` GiB default.

The resolved value is snapshotted on admission and sent to native BoxLite as
`disk_size_gb`. A later env change does not alter already accepted work. Do not
put disk capacity into image/runtime parameters, and do not increase
`BOXLITE_TIMEOUT_MS` to accommodate a slow clone.

Native BoxLite readiness must create a disposable sandbox with the resolved
disk value, start it, verify the guest root filesystem is consistent with the
request, verify the runtime/workspace tools, and delete the probe. The legacy
`cap-rest` protocol cannot prove native `disk_size_gb` enforcement. Keep
admission v2 closed when `BOXLITE_PROTOCOL_MODE=cap-rest` or when the probe is
skipped or inconclusive.

## Capacity preflight

The concurrency ceiling is not necessarily the current shell value. CAP uses:

1. persisted `system_settings.max_concurrent_tasks` when a row exists;
2. otherwise `MAX_CONCURRENT_TASKS`;
3. otherwise the product default `5`.

Determine that effective value before opening the gate. For an existing run
package, this query returns only the non-secret persisted ceiling:

```bash
docker compose -f docker-compose.prod.yml exec -T postgres sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
  "SELECT max_concurrent_tasks FROM system_settings WHERE id = '\''system'\''"'
```

Review every ready BoxLite environment and use the largest possible resolved
`diskSizeGb`, not merely the deployment fallback. The lower-bound reservation
is:

```text
required sandbox capacity GiB = effective concurrency * largest resolved diskSizeGb
```

The BoxLite host must have at least that much allocatable capacity plus room for
images/rootfs data, retained sandboxes, logs, and normal host operation. Guest
`df` proves the sandbox received its requested filesystem; it does not by itself
prove that the BoxLite host can sustain the aggregate concurrency ceiling. For
an external BoxLite endpoint, run the host-capacity check on that BoxLite host.
Do not infer its capacity from the CAP API host.

On the second, gate-opening quick-deploy run, the installer reads the persisted
ceiling and the largest ready BoxLite environment disk from the already running,
gate-disabled N API. Capacity evidence is process-only and is not written into
the API `.env`:

- for a same-host BoxLite endpoint, quick-deploy runs `df` on
  `$HOME/.boxlite`; set `BOXLITE_HOST_STORAGE_PATH=/absolute/host/path` only when
  BoxLite stores data on another local filesystem;
- for an external endpoint, run `df` on the actual BoxLite host, floor the
  available GiB, and pass that freshly reviewed integer as
  `BOXLITE_HOST_AVAILABLE_GB` to quick-deploy.

The preflight validates the configured bounds and compares that capacity proof
with the effective ceiling and largest resolvable BoxLite disk. Treat a failed,
stale, or unavailable proof as a blocker for enabling admission v2, even if the
legacy synchronous stack can otherwise start. The arithmetic is only a lower
bound; leave additional operational reserve.

## Stage 1: deploy the compatible release with the gate closed

1. Back up Postgres and the deployment `.env` together. Record the current
   API/Web image digests, provider mode, MCP setting, scheduler state, and
   effective concurrency ceiling.
2. Set stable, unique `CAP_INSTANCE_ID` values for all API processes. Do not use
   an ephemeral container hostname as deployment membership.
3. Set:

   ```ini
   CAP_TASK_ADMISSION_V2_ENABLED=false
   CAP_TASK_ADMISSION_V2_ATTESTATION_JSON=
   BOXLITE_DISK_SIZE_GB=5
   BOXLITE_GIT_CLONE_TIMEOUT_MS=900000
   ```

4. Deploy the additive migrations and the new API/worker code. Existing task
   creation remains on the legacy synchronous path while the gate is closed.
5. Run quick-deploy/native readiness and the capacity preflight. Do not use
   `CAP_BOXLITE_SKIP_RUNTIME_PROBE=1` as release evidence.
6. Run the release's provider conformance, secret-canary, public compatibility,
   and migration checks before attesting the deployment.

## Stage 2: collect exact role reports

The capability endpoint is read-only and protected by normal operator auth:

```bash
export CAP_CUTOVER_BEARER_TOKEN='<short-lived operator bearer>'
curl -fsS \
  -H "Authorization: Bearer ${CAP_CUTOVER_BEARER_TOKEN}" \
  http://127.0.0.1:8080/deployment-capabilities/task-admission-v2
```

Query every expected instance through an instance-pinned operator route. The
current monolith reports both required roles, `api` and `worker`. Each safe local
report contains only:

- schema version, stable instance id, role, and build identity;
- the `task-admission-v2` capability;
- process-local readiness and report timestamp.

A local `ready: true` report is not complete deployment evidence. Inventory all
replicas and manually construct `expectedWorkers`; never derive expected
membership from whichever processes happened to respond.

The attestation has this strict shape (replace the illustrative report objects
with the exact objects returned by each instance):

```json
{
  "schemaVersion": 1,
  "deploymentId": "stable-deployment-id",
  "expectedWorkers": [
    {
      "instanceId": "stable-api-1",
      "roles": ["api", "worker"]
    }
  ],
  "reports": [
    {
      "schemaVersion": 1,
      "instanceId": "stable-api-1",
      "role": "api",
      "buildIdentity": "vX.Y.Z",
      "capabilities": ["task-admission-v2"],
      "ready": true,
      "reportedAt": "2026-07-16T00:00:00.000Z"
    },
    {
      "schemaVersion": 1,
      "instanceId": "stable-api-1",
      "role": "worker",
      "buildIdentity": "vX.Y.Z",
      "capabilities": ["task-admission-v2"],
      "ready": true,
      "reportedAt": "2026-07-16T00:00:00.000Z"
    }
  ],
  "attestedAt": "2026-07-16T00:01:00.000Z",
  "expiresAt": "2026-07-16T00:16:00.000Z"
}
```

Use a deliberately short expiry. The gate stays closed for malformed JSON,
missing or unexpected members, duplicate instance/role reports, a missing
capability, a non-ready report, mixed build identities, or an expired
attestation. The endpoint exposes only the evaluated gate and fresh local
reports; it never echoes the raw attestation or process environment.

## Stage 3: open the gate atomically from the operator's perspective

1. Start a short write freeze. Block Console/REST and Public V1 task creates,
   disable MCP writers, and set `SCHEDULED_TASKS_DISABLED=1`. Existing tasks may
   continue; the freeze prevents requests from seeing a mixture of gate states
   while processes restart.
2. Put the compact one-line JSON into
   `CAP_TASK_ADMISSION_V2_ATTESTATION_JSON`, set
   `CAP_TASK_ADMISSION_V2_ENABLED=true`, and force-recreate every API process.
   Gate configuration is read at process construction; a container env edit
   without recreation has no effect. The quick-deploy path additionally requires
   the short-lived, process-only `CAP_CUTOVER_BEARER_TOKEN` collected in Stage 2
   so it can authenticate the post-restart capability check; it never persists
   or prints that token.
3. Query every instance-pinned capability endpoint and require
   `gate.open === true`. Any closed reason blocks reopening writes.
4. Re-enable schedules and MCP only after every instance is open, then reopen
   external task-write ingress last.
5. Run one owner-authenticated smoke through each create surface:

   - Console REST (`POST /repos/:repoId/tasks`);
   - Public V1 (`POST /v1/tasks` with an idempotency key);
   - MCP `create_task`.

   Each call must return the committed Task before clone settlement. Poll the
   canonical task read and require the same safe provisioning stages/failure
   codes across all three surfaces. Use a verified non-`main` default branch,
   then stop/complete the tasks and verify there are no probe boxes or temporary
   Git credential files.

## Safe diagnostics

Use stable counts and public-safe fields. This query does not read lease owner,
Git output, provider request bodies, credentials, or raw diagnostics:

```bash
docker compose -f docker-compose.prod.yml exec -T postgres sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off -c \
  "SELECT state, stage, COALESCE(cause_code, '\''-'\'') AS cause_code, COUNT(*)
     FROM task_admission_work
    GROUP BY state, stage, cause_code
    ORDER BY state, stage, cause_code"'
```

It is also safe to inspect the authenticated Task projection (`provisioning`,
`failure`, resolved branch, attempt, and timestamps), capability gate reason,
aggregate host/guest capacity, and stage duration. Do not collect or paste:

- the whole `.env`, `docker inspect` environment, or process environment;
- authenticated clone/push command payloads or temporary Git config contents;
- forge tokens, BoxLite tokens, Authorization headers, or credential canaries;
- raw provider/Git stderr into Task, audit, support tickets, or retained run
  metadata.

Use the stable capacity/timeout/auth/TLS-network/ref/unknown cause code and its
documented action. If classification is uncertain, retain the safe `unknown`
code rather than persisting raw output.

## Drain-first rollback

Never start N-1 code while unfinished admission-v2 work can still be claimed.

1. Freeze all task writers again, disable MCP, and set
   `SCHEDULED_TASKS_DISABLED=1`.
2. On the still-compatible N release, set
   `CAP_TASK_ADMISSION_V2_ENABLED=false`, remove the attestation, force-recreate
   every API process, and require each capability endpoint to report a closed
   gate. New requests would now use the legacy path, but keep ingress frozen
   until rollback completes.
3. Let N workers finish or safely cancel every row in `accepted`, `queued`,
   `running`, or `retrying`. Use normal stop/cancellation APIs when operator
   intervention is needed; do not rewrite Task/admission state by hand.
4. This count must reach zero and remain zero across at least one worker polling
   interval:

   ```bash
   docker compose -f docker-compose.prod.yml exec -T postgres sh -lc \
     'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
     "SELECT COUNT(*) FROM task_admission_work
       WHERE state IN ('\''accepted'\'', '\''queued'\'', '\''running'\'', '\''retrying'\'')"'
   ```

5. Confirm provider inventory has no provisioning/deleting sandbox for a
   drained row and that normal slot accounting matches the configured ceiling.
6. Only now roll API/worker code back. Keep the additive tables, columns,
   indexes, nullable response fields, and terminal work history in place.
   Destructive down-migration is not an emergency rollback step.
7. Reopen schedules, MCP, and external task writes only after N-1 health and
   its legacy task-create smoke pass.

If the drain cannot settle, keep N running with the gate closed and writers
frozen while repairing or cancelling through the compatible code. Database
uncertainty, an active lease, or indeterminate provider ownership is a stop
condition, not permission to force a downgrade.
