-- AddColumn: store the operator's GitHub OAuth access token server-side (never
-- exposed to the browser) for later GitHub-import calls. Nullable so existing
-- rows and token-less refreshes remain valid.
ALTER TABLE "users" ADD COLUMN "github_access_token" TEXT;
