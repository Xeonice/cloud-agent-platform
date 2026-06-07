-- AddColumn: store the OFFICIAL-mode ChatGPT login (`~/.codex/auth.json`)
-- ENCRYPTED at rest (ciphertext.iv.authTag), never plaintext. The sandbox
-- provider decrypts + injects it per task so the Codex execution credential is
-- configured via the Settings "official subscription" entry rather than a
-- deployment env var. Nullable so existing rows / compatible-mode rows stay valid.
ALTER TABLE "codex_credentials" ADD COLUMN "auth_json_ciphertext" TEXT;
