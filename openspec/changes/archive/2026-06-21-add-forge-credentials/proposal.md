# Forge credentials: connect GitHub / GitLab / Gitee for repo read+write

## Why

Tasks edit a sandbox clone; landing those edits back (change C, `add-multi-forge-task-delivery`)
requires a WRITE-scoped credential for the repo's forge. Today the only forge credential is the
operator's GitHub OAuth LOGIN token (`User.githubAccessToken`), which: (a) exists only for GitHub —
GitLab/Gitee have no credential in the schema at all; (b) is the LOGIN token, whose scope may not grant
write; and (c) is stored PLAINTEXT (`schema.prisma:171`), unlike codex/claude creds (AES-256-GCM).

This change is the credential foundation: a way for an operator to CONNECT each forge (GitHub, GitLab,
Gitee — incl. self-hosted) with a write-scoped credential, stored encrypted, owner-scoped, mirroring the
existing `CodexCredential`/`ClaudeCredential` pattern. Change C consumes it; this change ships no
push-back itself.

## What Changes

- **PAT-paste connect (v1 connection mechanism).** The operator creates a Personal Access Token in the
  forge (with the documented scopes) and pastes it into a new Settings "code-hosting connection" card —
  mirroring the existing token-paste connect for codex-compatible / claude. NO per-forge / per-instance
  OAuth App registration (the friction that would kill self-hosted). OAuth authorization-code is a
  deferred polish for the public SaaS forges, not v1.
- **`ForgeCredential` model.** Per-user, `kind` (`github|gitlab|gitee`) + `host` (self-hosted; null for
  public) typed, AES-256-GCM token ciphertext (`settings-crypto` + `CODEX_CRED_ENC_KEY`, the
  `ciphertext.iv.authTag` envelope), masked `last4`, `state`, `@@unique([userId, kind, host])`, cascade
  on user delete. Only ciphertext + last4 persisted; plaintext decrypted only at point of use.
- **`ForgeConnection` model (self-hosted registry).** Operator-configured `host → kind + apiBaseUrl`
  (`/api/v3` GitHub Enterprise, `/api/v4` GitLab, `/api/v5` Gitee), optional cached project id, so a
  self-hosted host (which can't be inferred) resolves to a forge + API base. Plain storage — a forge call
  is a trusted call to the operator's own forge, so it does NOT go through `assertSafeProviderUrl` (that
  guard stays scoped to the compatible-provider gateway); private/LAN hosts are allowed.
- **Connect + validate flow.** On connect, validate the token against the forge API (a cheap native fetch
  that confirms the token is live) before storing; surface `connected`/`not_connected` and the masked
  last4 — never the plaintext.
- **Companion: encrypt `User.githubAccessToken` at rest.** Orthogonal hygiene (the token is already `repo`
  read+write scoped). Encrypt via ONE shared decrypt helper used by ALL THREE readers (login write,
  clone read, repo-import Bearer read); boot fail-fast when the key is required but absent; the migration
  is a simple full re-encrypt sweep (no legacy data to preserve).

## Impact

- **Code:** `apps/api/prisma/schema.prisma` (new `ForgeCredential` + `ForgeConnection` models; encrypt
  `User.githubAccessToken`; one additive migration), `apps/api/src/settings/*` (the connect/validate +
  secret-free read endpoints, reusing `settings-crypto`), the auth/session + clone + repo-import token
  paths (one shared encrypt/decrypt helper for `githubAccessToken`), `packages/contracts` (the
  forge-connection DTOs). Settings console UI (the connection card) — design mockup handled in OpenDesign,
  implemented with the rest of the settings surface.
- **Specs (ADDED):** new capability `forge-credentials`.
- **Out of scope:** the Forge port + push-back + repo-source detection (change C consumes these
  credentials); OAuth authorization-code connect (deferred); multi-provider LOGIN (change A, next
  iteration — this change does NOT touch how users authenticate INTO the platform).
- **Decisions baked (ratify):** PAT-paste over OAuth for v1; per-user credential (a deployment-bot
  fallback is a noted future option); forge calls are trusted native-fetch to the operator's connected
  forge (NOT SSRF-gated; `assertSafeProviderUrl` unchanged), so internal self-hosted forges work by a
  plain fetch and cross-network reachability is the self-deployer's responsibility; `githubAccessToken`
  encrypted this iteration as a simple full sweep (all three readers decrypt, boot fail-fast on missing
  key). Bound by [[codex-headless-chatgpt-auth]] credential discipline.
