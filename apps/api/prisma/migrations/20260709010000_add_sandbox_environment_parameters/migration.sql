ALTER TABLE "sandbox_environments"
  ADD COLUMN "env_vars" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "secret_env_vars" JSONB NOT NULL DEFAULT '{}';
