DELETE FROM "sandbox_environment_validations"
WHERE "environment_id" IN (
  SELECT "id"
  FROM "sandbox_environments"
  WHERE "source"->>'kind' IN (
    'aio-loaded-docker-image',
    'boxlite-rootfs',
    'provider-template'
  )
);

DELETE FROM "sandbox_environments"
WHERE "source"->>'kind' IN (
  'aio-loaded-docker-image',
  'boxlite-rootfs',
  'provider-template'
);
