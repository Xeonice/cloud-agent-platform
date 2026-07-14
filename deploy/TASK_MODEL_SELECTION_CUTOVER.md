# Task model selection: mandatory N/N-1 cutover and rollback

Task model selection is not a rolling-upgrade-safe additive field. The N-1 API
accepts unknown JSON, then its production Zod schemas strip both top-level
`model` and nested `taskTemplate.model`. A nullable database column therefore
does not protect intent, and the N process-local gate cannot prove that an N-1
writer or claimer is absent.

Use this maintenance-window procedure for the first model-aware release. Do not
publish the matching Web client, re-enable MCP, or reopen task/schedule write
ingress until every check below succeeds.

## Preconditions

- Run the required `task model N-1 compatibility` CI job. Its successful
  result means the isolated predecessor really reproduced unknown-field
  stripping; it does **not** mean N-1 supports model-aware requests.
- Back up Postgres and the deployment `.env` together.
- Record the current Web/API image digests, MCP enabled state, and ingress
  configuration.
- Assign every API process a stable `CAP_INSTANCE_ID`. Do not rely on Docker's
  changing container hostname.
- Stage N API and sandbox images, but do not expose the N Web client yet.

## Upgrade: close writers before publishing the contract

1. Set `CAP_TASK_MODEL_SELECTION_ENABLED=false` and remove any stale
   `CAP_TASK_MODEL_SELECTION_ATTESTATION_JSON`.
2. At the load balancer, Tunnel, or reverse proxy, return a maintenance `503`
   for all external API traffic. This includes task, schedule, catalog, MCP,
   and the otherwise-public model-aware metadata routes `/v1/openapi.json` and
   `/v1/docs`. Keep only a loopback/operator path for health and authenticated
   capability probes. External probes for both metadata routes and every write
   ingress must observe the proxy's maintenance `503`, not an application
   `200`, `400`, or `401`.
3. Disable MCP writers before stopping processes. Preserve the previous value,
   then update the existing settings row:

   ```sql
   SELECT id, mcp_server_enabled FROM system_settings;
   UPDATE system_settings SET mcp_server_enabled = false;
   ```

   No row means MCP is already fail-closed.
4. Stop every N-1 API, admission, scheduler, and runtime worker. Verify process
   and container inventories, including manually started replicas and old
   compose projects. There must be no N-1 process able to write or claim work.
5. Deploy N database migrations and N API workers with the gate still closed,
   MCP disabled, Web stopped, and external ingress closed. Recreate processes
   after every gate-related env change because gate config is read at startup.
6. For every N instance, query its loopback/operator endpoint. The capability
   endpoint is protected by the normal operator authentication guard; provision
   a short-lived bearer for an allowed operator account and do not expose it in
   logs or the attestation:

   ```bash
   export CAP_CUTOVER_BEARER_TOKEN='<short-lived operator bearer>'
   curl -fsS http://127.0.0.1:8080/version
   curl -fsS -H "Authorization: Bearer ${CAP_CUTOVER_BEARER_TOKEN}" \
     http://127.0.0.1:8080/deployment-capabilities/task-model-selection-v1
   ```

   Confirm the expected N build and four local capability reports (`api`,
   `admission`, `scheduler`, `runtime`) with `task-model-selection-v1`, the
   stable instance id, and the same build identity that will enter the
   attestation. A report's current `ready: true` is a process-local declaration,
   not an external readiness measurement. Independently retain evidence for the
   completed migration, maintenance responses (including `/v1/openapi.json` and
   `/v1/docs`), disabled MCP setting, complete process/container inventory, and
   N-1 compatibility result. Do not infer any of those facts from `ready`.
7. Build a complete-membership attestation from the actual reports. It must name
   every instance/role and set all five cutover facts to true:

   - `databaseMigrationComplete`
   - `writeIngressClosedDuringCutover`
   - `mcpWritersDisabledDuringCutover`
   - `legacyWorkersRemoved`
   - `compatibilityChecksPassed`

   For a single all-role instance, the shape is:

   ```json
   {
     "schemaVersion": 1,
     "deploymentId": "stable-deployment-id",
     "expectedWorkers": [
       {
         "instanceId": "stable-api-1",
         "roles": ["api", "admission", "scheduler", "runtime"]
       }
     ],
     "reports": ["copy the four exact localReports objects here"],
     "databaseMigrationComplete": true,
     "writeIngressClosedDuringCutover": true,
     "mcpWritersDisabledDuringCutover": true,
     "legacyWorkersRemoved": true,
     "compatibilityChecksPassed": true,
     "attestedAt": "current ISO-8601 UTC time",
     "expiresAt": "a deliberately short future ISO-8601 UTC time"
   }
   ```

   `reports` must be an array of the report objects, not the illustrative string
   above. Multi-instance deployments must include complete expected membership;
   one N instance cannot attest that a forgotten N-1 instance is gone. Set the
   five booleans only from the independent operator evidence collected above;
   `localReports[].ready` does not prove any deployment-wide cutover fact.
8. Set the compact JSON as `CAP_TASK_MODEL_SELECTION_ATTESTATION_JSON`, set
   `CAP_TASK_MODEL_SELECTION_ENABLED=true`, and force-recreate every N API
   process. Query every protected capability endpoint again with the bearer
   header and require `gate.open === true`.
9. Behind the still-closed external ingress, authenticate as a real owner and:

   - query the catalog for the exact runtime/environment context;
   - select an id dynamically from that response;
   - create, launch, inspect transcript metadata, and stop one explicit-model
     task;
   - create one omitted-model task and verify legacy default behavior;
   - verify the taskless catalog probe resource was reclaimed.

### Claude reference-subscription evidence gate

The checked Claude selector manifest is intentionally empty until this gate has
run. Do not populate it from CLI help text, a frontend picker, remembered model
names, or a fabricated JSON manifest. The evidence flow has two ordered phases:

1. Build the exact AIO and BoxLite images being released. Copy
   `deploy/task-model-claude-artifact-evidence.example.json` outside the
   repository, replace both image references, and replace the candidate selector
   plus its current primary-source provenance. Then run:

   ```bash
   export CAP_TASK_MODEL_REAL_CREDENTIAL_E2E=1
   export TASK_MODEL_REAL_CREDENTIAL_CLAUDE_OAUTH_TOKEN='<reference subscription secret>'
   export TASK_MODEL_CLAUDE_ARTIFACT_CONFIG=/secure/path/claude-artifact-config.json
   export TASK_MODEL_CLAUDE_ARTIFACT_EVIDENCE=/secure/path/claude-artifact-evidence.json
   export TASK_MODEL_CLAUDE_ARTIFACT_MANIFEST=/secure/path/claude-artifact-manifest.json
   pnpm test:e2e:claude-model-artifact-evidence
   ```

   The runner computes the real Claude executable checksum inside each image,
   runs every selector once per unique checksum using structured `stream-json`,
   and exercises at least one launch through each AIO/BoxLite image seam. It
   writes only a digest of CLI output, requested/actual model facts, and image/
   artifact identities. It never writes the OAuth token or raw model output.
   The promoted manifest is checksum-bound to that evidence and continues to
   label selectors as `cli-version-verified`/`supported-subset`; it is not owner
   entitlement discovery.

2. Review the artifact evidence, make the promoted manifest available to the N
   API as `CAP_CLAUDE_MODEL_CAPABILITY_MANIFEST_JSON`, and restart N while
   ingress and MCP writers are still closed. Copy
   `deploy/task-model-real-credential-e2e.example.json` outside the repository,
   replace the real repo/environment ids, exact artifact checksums, and the full
   promoted selector set. With a short-lived API bearer token scoped to
   `tasks:read,tasks:write`, run:

   ```bash
   export CAP_TASK_MODEL_REAL_CREDENTIAL_E2E=1
   export TASK_MODEL_REAL_CREDENTIAL_BASE_URL='http://127.0.0.1:8080'
   export TASK_MODEL_REAL_CREDENTIAL_BEARER_TOKEN='<short-lived scoped token>'
   export TASK_MODEL_REAL_CREDENTIAL_CONFIG=/secure/path/task-model-e2e-config.json
   export TASK_MODEL_REAL_CREDENTIAL_ARTIFACT_EVIDENCE=/secure/path/claude-artifact-evidence.json
   export TASK_MODEL_REAL_CREDENTIAL_EVIDENCE=/secure/path/task-model-e2e-evidence.json
   export TASK_MODEL_REAL_CREDENTIAL_MANIFEST=/secure/path/task-model-final-manifest.json
   pnpm test:e2e:task-model-real-credential
   ```

   Before any network request, this phase verifies the config's selectors,
   provenance, CLI version/checksum, and every provider seam against the signed
   phase-one artifact evidence; a manually copied mismatch fails closed. It then
   calls the production catalog, V1 create/get/transcript paths, and the real
   launch seam. It runs every selector once per unique checksum and one
   representative task per additional provider seam, requires a completed Task
   plus retained assistant transcript, and records requested versus independently
   reported actual model (or honest `unknown`). A failed/incomplete task is
   stopped best-effort and produces no evidence file. Review the final evidence
   and promote its manifest into the checked source fixture; do not treat the
   temporary environment override as the release artifact.

Both phases make real provider calls and can consume subscription quota. They
must be invoked only with explicit credential/cost authorization, in an isolated
staging deployment or this still-closed maintenance window. Evidence and
manifest paths are created with mode `0600` and refuse to overwrite an existing
file.

10. Start the matching N Web client. Restore MCP only if it was previously
    enabled, then reopen external ingress last. Monitor the attestation expiry;
    rebuild, instance membership, `CAP_INSTANCE_ID`, or expiry changes require a
    new complete attestation and process recreate.

`scripts/upgrade.sh` may stage/recreate images inside this window, but it does
not close ingress, disable MCP, enumerate N-1 workers, generate an attestation,
or enforce rollback blockers. It is not a complete cutover procedure.

## Rollback: drain model-aware state before N-1 starts

1. Close external ingress and disable MCP again. Stop every N worker before any
   gate-related restart so a scheduler cannot claim or retry accepted work in
   the gap between a gate flip and its own shutdown.
2. Set `SCHEDULED_TASKS_DISABLED=1`, set the N gate false, remove the
   attestation, and restart only the minimum N control-plane/API workers needed
   for inspection and normal task stop. For a combined all-role process, the
   scheduler-disabled env is mandatory. Verify the protected capability
   endpoint with an authenticated operator bearer, require the gate to be
   closed, and retain process/inventory evidence showing no active scheduler or
   retry claimer before continuing.
3. Pause all enabled explicit-model schedules while
   retaining their templates for a later N recovery:

   ```sql
   UPDATE task_schedules
   SET enabled = false,
       next_run_at = NULL,
       updated_at = NOW()
   WHERE enabled
     AND jsonb_typeof(task_template->'model') = 'string';
   ```

4. Use the normal stop API to wait for or cancel every non-terminal
   explicit-model Task. Do not update Task status directly; normal stop owns
   sandbox teardown and terminal audit behavior.
5. With all remaining workers stopped and a fresh backup in hand, terminalize any paused
   pre-task retrying occurrence in one controlled transaction. There is
   currently no public admin operation for this transition:

   ```sql
   BEGIN;
   UPDATE task_schedule_runs
   SET status = 'failed',
       error = COALESCE(
         error,
         'Runtime model catalog retry was closed for deployment rollback.'
       ),
       error_code = 'runtime_model_catalog_unavailable',
       retry_at = NULL,
       admission_claim_token = NULL,
       admission_claim_until = NULL,
       updated_at = NOW()
   WHERE status = 'retrying'
     AND jsonb_typeof(retry_task_template->'model') = 'string';
   COMMIT;
   ```

6. Run this blocking preflight. Any exception means rollback must stop:

   ```sql
   DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM tasks
       WHERE model IS NOT NULL
         AND status::text NOT IN (
           'completed', 'failed', 'cancelled', 'agent_failed_to_start'
         )
     ) THEN
       RAISE EXCEPTION 'non-terminal explicit-model tasks remain';
     END IF;

     IF EXISTS (
       SELECT 1 FROM task_schedules
       WHERE enabled
         AND jsonb_typeof(task_template->'model') = 'string'
     ) THEN
       RAISE EXCEPTION 'enabled explicit-model schedules remain';
     END IF;

     IF EXISTS (
       SELECT 1 FROM task_schedule_runs
       WHERE status = 'retrying'
         AND jsonb_typeof(retry_task_template->'model') = 'string'
     ) THEN
       RAISE EXCEPTION 'retrying explicit-model occurrences remain';
     END IF;

     IF EXISTS (
       SELECT 1
       FROM task_schedule_runs r
       JOIN task_schedules s ON s.id = r.schedule_id
       WHERE r.status = 'claimed'
         AND (
           jsonb_typeof(r.retry_task_template->'model') = 'string'
           OR jsonb_typeof(s.task_template->'model') = 'string'
         )
     ) THEN
       RAISE EXCEPTION 'claimed explicit-model occurrences remain';
     END IF;
   END
   $$;
   ```

7. Only after the blocker is clean may N-1 API plus its
   matching N-1 Web client start. Keep additive database columns/migrations; do
   not run a destructive downgrade.
8. While N-1 is active, do not edit or resume the retained explicit-model
   schedules: an N-1 full-template write strips `model`. Roll back all
   model-aware external clients before restoring MCP and ingress.

The catalog route, OpenAPI schema, and MCP tool are statically registered in N;
a closed process-local gate does not make those contracts disappear. The first
cutover publication boundary is maintenance ingress (including the public docs
routes) plus disabled MCP, while the N server gate remains the final acceptance
boundary for any raw payload that reaches the process. UI hiding is neither.
