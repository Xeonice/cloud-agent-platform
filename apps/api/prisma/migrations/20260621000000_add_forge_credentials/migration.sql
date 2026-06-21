-- add-forge-credentials: per-account forge push-back credentials (encrypted) + the
-- self-hosted forge connection registry. `User.github_access_token` is NOT altered
-- here — it stays TEXT (nullable); encryption-at-rest is an application-layer change
-- (the column now stores the joined `ciphertext.iv.authTag` envelope), re-encrypted
-- by a full sweep at the app layer (no legacy data to preserve carefully).

-- CreateTable
CREATE TABLE "forge_credentials" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "token_ciphertext" TEXT NOT NULL,
    "token_last4" TEXT,
    "state" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forge_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "forge_credentials_user_id_idx" ON "forge_credentials"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "forge_credentials_user_id_kind_host_key" ON "forge_credentials"("user_id", "kind", "host");

-- AddForeignKey
ALTER TABLE "forge_credentials" ADD CONSTRAINT "forge_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "forge_connections" (
    "host" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "api_base_url" TEXT NOT NULL,
    "project_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forge_connections_pkey" PRIMARY KEY ("host")
);
