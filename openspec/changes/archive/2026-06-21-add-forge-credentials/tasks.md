# Tasks — add-forge-credentials

## 1. Schema + migration

- [x] 1.1 Add `ForgeCredential` model (userId FK cascade, kind, nullable host, tokenCiphertext, nullable
  tokenLast4, state, timestamps, `@@unique([userId,kind,host])`, `@@index([userId])`) to `schema.prisma`.
- [x] 1.2 Add `ForgeConnection` model (host PK, kind, apiBaseUrl, nullable projectId, createdAt).
- [x] 1.3 Convert `User.githubAccessToken` to an encrypted-at-rest envelope (same `ciphertext.iv.authTag`
  shape); migration re-encrypts existing rows.
- [x] 1.4 One additive Prisma migration; `prisma generate`.

## 2. Contracts

- [x] 2.1 Add forge-credential + forge-connection DTOs to `packages/contracts` (connect request
  `{kind, host?, token}`; secret-free read `{kind, host, state, last4}`; connection `{host, kind, apiBaseUrl}`).

## 3. Connect + validate + storage

- [x] 3.1 A `ForgeCredentialService` (settings): `connect({kind,host,token})` → resolve apiBase (public
  inference or the `ForgeConnection` for self-hosted) → live token probe (authenticated native fetch to the
  operator's connected forge — NOT `assertSafeProviderUrl`-gated) → on success `encryptSecret` + upsert
  `ForgeCredential` (state=connected, last4); on failure reject with a distinct reason, store nothing.
- [x] 3.2 `getForgeCredential(userId, kind, host)` → decrypt at point of use (the primitive change C's
  owner-scoped resolution builds on); never logs/returns plaintext.
- [x] 3.3 `disconnect`/secret-free `read` returning `{kind, host, state, last4}` only.
- [x] 3.4 `ForgeConnection` register/read (self-hosted host→kind→apiBaseUrl + cached gitlab project id) —
  plain storage; no SSRF gate (forge calls are trusted; `assertSafeProviderUrl` untouched). Private/LAN
  hosts are allowed.

## 4. Encrypt githubAccessToken companion

- [x] 4.1 Encrypt `User.githubAccessToken` at rest via ONE shared decrypt helper used by ALL THREE readers
  — `auth-session.service.ts` (login write), `prisma-provision-lookup.ts` (clone read), AND
  `github-import.service.ts` `readOperatorToken` (Bearer read) — keep it a plain column (NOT migrated into
  ForgeCredential). Boot fail-fast when encryption is enabled but no valid key is set (no env fallback).
  Migration = simple full re-encrypt sweep (no legacy data to preserve).

## 5. Settings endpoints + (UI deferred to OpenDesign)

- [x] 5.1 `GET /settings/forges` (secret-free list) + `PUT /settings/forges` (connect/validate) +
  `DELETE` (disconnect) + the `ForgeConnection` register endpoint, behind the same auth gate as the
  codex/claude settings endpoints.
- [x] 5.2 (UI) the "code-hosting connection" settings card — DESIGN MOCKUP handled in OpenDesign;
  implemented alongside the settings surface (not blocking the backend).

## 6. Tests

- [x] 6.1 Connect stores encrypted + masked + validated; invalid token rejected (no row); round-trip
  decrypt; read never exposes the token; unique (user,kind,host).
- [x] 6.2 `ForgeConnection` store/read (incl. private/LAN host allowed); self-hosted apiBase suffix per kind.
- [x] 6.3 `User.githubAccessToken` encrypt-on-write + decrypt round-trip across ALL THREE readers (login /
  clone / repo-import); boot fail-fast when key missing; full re-encrypt sweep.

## 7. Verify

- [x] 7.1 `pnpm --filter @cap/api typecheck` + full `test` green.
- [ ] 7.2 Manual: connect a real GitLab + Gitee PAT, confirm validate passes + stored encrypted + read
  secret-free (this is the prerequisite for change C's empirical push-back smoke).
