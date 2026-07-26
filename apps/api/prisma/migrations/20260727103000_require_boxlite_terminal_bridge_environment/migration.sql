UPDATE "sandbox_environments"
SET "status" = 'stale'
WHERE "status" = 'ready'
  AND "contract_version" IS DISTINCT FROM 'sandbox-environment-v3';
