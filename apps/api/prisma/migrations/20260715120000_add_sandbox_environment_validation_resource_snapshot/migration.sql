-- Pin the provider-neutral resources used by a successful or failed probe so
-- later deployment-default changes cannot alter task provisioning semantics.
ALTER TABLE "sandbox_environment_validations"
ADD COLUMN "resource_snapshot" JSONB;

ALTER TABLE "sandbox_environment_validations"
ADD CONSTRAINT "sandbox_environment_validations_resource_snapshot_check"
CHECK (
  "resource_snapshot" IS NULL OR (
    jsonb_typeof("resource_snapshot") = 'object' AND
    ("resource_snapshot" - 'diskSizeGb') = '{}'::jsonb AND
    CASE
      WHEN NOT ("resource_snapshot" ? 'diskSizeGb') THEN true
      WHEN jsonb_typeof("resource_snapshot" -> 'diskSizeGb') <> 'number' THEN false
      WHEN ("resource_snapshot" ->> 'diskSizeGb') !~ '^[0-9]+$' THEN false
      ELSE ("resource_snapshot" ->> 'diskSizeGb')::integer BETWEEN 1 AND 1024
    END
  )
);
