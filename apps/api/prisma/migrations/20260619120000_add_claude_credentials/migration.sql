-- CreateTable
CREATE TABLE "claude_credentials" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "setup_token_ciphertext" TEXT,
    "setup_token_last4" TEXT,
    "api_key_ciphertext" TEXT,
    "api_key_last4" TEXT,
    "default_model" TEXT,

    CONSTRAINT "claude_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "claude_credentials_user_id_key" ON "claude_credentials"("user_id");

-- AddForeignKey
ALTER TABLE "claude_credentials" ADD CONSTRAINT "claude_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
