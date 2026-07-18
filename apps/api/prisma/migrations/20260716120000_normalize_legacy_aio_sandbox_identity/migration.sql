-- Before sandbox providers exposed an explicit physical identity, AIO owner
-- rows persisted the logical CAP task id as provider_sandbox_id. The current
-- restart path correctly treats provider_sandbox_id as an exact Docker target,
-- so those historical rows prevent the provider's read-only inventory scan
-- from re-adopting an otherwise healthy container.
--
-- Remove only the demonstrably synthetic identity for restart candidates. A
-- NULL provider_sandbox_id is the existing legacy-owner representation: AIO
-- first discovers the running container and its real id from Docker inventory,
-- then reattaches through that provider-attested identity. Rows with a physical
-- id, a generation fence, an unresolved create, another provider, or a task
-- outside the restart-re-adoption states remain untouched. NULL is also
-- compatible with the preceding AIO implementation, which already discovered
-- legacy owners from its startup inventory rather than from a stored exact id.
UPDATE "sandbox_runs" AS run
SET "provider_sandbox_id" = NULL
FROM "tasks" AS task
WHERE task."id" = run."task_id"
  AND task."status" IN ('running', 'awaiting_input')
  AND run."provider_id" = 'aio-local'
  AND run."status" = 'running'
  AND run."provider_sandbox_id" = run."task_id"
  AND run."owner_generation" IS NULL
  AND run."resource_generation" IS NULL
  AND run."create_state" = 'idle';
