# Design — add-forge-credentials

## Context

Foundation for multi-forge push-back (change C). Reuse the proven `CodexCredential`/`ClaudeCredential`
credential pattern verbatim; add a forge-credential sibling + a self-hosted host registry + a PAT-paste
connect flow; and close the plaintext-`githubAccessToken` gap. NO push-back, NO login changes here.

## D1 — Connection mechanism: PAT paste (NOT OAuth) for v1

The codebase already has three connect precedents: OAuth authorization-code (GitHub login), OAuth
device-code (codex official, `codex-device-login.service.ts`), and token paste (codex compatible /
claude). For forge credentials we choose **token paste (PAT)** because:
- It needs ZERO OAuth-App registration. OAuth would require registering an app per forge AND per
  self-hosted instance — the exact friction that kills enterprise self-hosting (the north star here).
- It is uniform across all three forges and self-hosted day-one (the operator just mints a PAT on their
  own instance).
- It reuses the existing token-paste + encrypt-at-rest path verbatim.

Connect input: `{ kind: 'github'|'gitlab'|'gitee', host?: string (self-hosted), token: string }`. OAuth
authorization-code for the public SaaS forges is a deferred enhancement (the `kind`/`host` shape leaves
room). PAT scopes the operator must grant (surfaced in the connect UI):
- github: `repo` (or fine-grained contents:write + pull_requests:write)
- gitlab: `api` (includes write_repository)
- gitee: `projects` + `pull_requests`

## D2 — `ForgeCredential` model (sibling of CodexCredential)

```
model ForgeCredential {
  id              String  @id @default(cuid())
  userId          String  @map("user_id")
  user            User    @relation(fields:[userId], references:[id], onDelete: Cascade)
  kind            String                      // 'github' | 'gitlab' | 'gitee'
  host            String? @map("host")        // self-hosted host; null for public SaaS
  tokenCiphertext String  @map("token_ciphertext")  // ciphertext.iv.authTag (settings-crypto)
  tokenLast4      String? @map("token_last4")
  state           String                      // 'connected' | 'not_connected'
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  @@unique([userId, kind, host])              // one operator may target several forges/hosts
  @@index([userId])
}
```
Encryption reuses `settings-crypto` (`encryptSecret`/`decryptSecret`/`resolveEncryptionKey`/
`maskApiKeySuffix`) + `CODEX_CRED_ENC_KEY` + the 3-part `ciphertext.iv.authTag` envelope that
`PrismaCodexAuthSource.decryptCiphertext` already parses. Only `state` + `tokenLast4` are ever read back
to the client; the plaintext token is decrypted only at point of use (by change C).

## D3 — `ForgeConnection` model (self-hosted host registry)

A self-hosted host cannot be inferred (a private host could be any forge). The operator registers it:
```
model ForgeConnection {
  host        String  @id          // e.g. git.corp.com
  kind        String                // 'github' | 'gitlab' | 'gitee'
  apiBaseUrl  String  @map("api_base_url")  // https://{host}/api/{v3|v4|v5}
  projectId   String? @map("project_id")    // GitLab numeric id cache (avoids %2F path)
  createdAt   DateTime @default(now())
}
```
Public hosts (github.com/gitlab.com/gitee.com) need NO row — they're inferred by change C. `ForgeConnection`
is plain storage: host → kind + apiBaseUrl (+ cached gitlab project id) for change C to call. A forge call
is a TRUSTED call to the operator's OWN connected forge (not an arbitrary URL), so it does NOT go through
`assertSafeProviderUrl` — that guard stays UNCHANGED and scoped to the compatible-provider gateway. There
is therefore no private-IP question here: an internal self-hosted GitLab/Gitee on a private LAN works by a
plain native fetch. Whether the platform can ROUTE to a self-hosted host is the self-deployer's network
responsibility, not designed around. (Multi-user, change A, will admin-gate who can register a host.)

## D4 — Connect + validate

On `PUT`/connect: validate the token BEFORE storing — a cheap authenticated GET against the resolved
`apiBaseUrl` (e.g. the current-user / a repo metadata endpoint) confirming the token is live. This is a
plain native fetch to the operator's connected forge (NOT `assertSafeProviderUrl`-gated). Reject a
dead/insufficient token with a distinct reason; never store an unvalidated token. On success: encrypt,
store, `state='connected'`, `tokenLast4` masked. Read endpoints return only `{kind, host, state, last4}`
— never the token.

## D5 — Companion: encrypt `User.githubAccessToken` at rest

`User.githubAccessToken` is plaintext today; encrypt it at rest as good hygiene (it is already a
`repo`-scoped read+write token, so this is orthogonal to push-back — not gated on it). There is no
precious legacy data to preserve, so the migration is a simple full re-encrypt sweep (or wipe → re-login),
NOT a delicate row-by-row ceremony. Centralize decryption in ONE helper used by ALL THREE readers — the
OAuth login persist (`auth-session.service.ts`, write), the clone-auth resolution
(`prisma-provision-lookup.ts`, read), AND the repo-import token read (`github-import.service.ts`
`readOperatorToken`, read as a Bearer) — otherwise an un-updated reader 401s after encryption. Boot
fail-fast when github-token encryption is enabled but no valid `CODEX_CRED_ENC_KEY` is set (unlike codex,
a github-token decrypt has NO env fallback — a failure breaks clone). Keep it a plain (non-ForgeCredential)
column — it remains the github-public-host fallback for change C; do NOT migrate login into ForgeCredential.

## D6 — what this change does NOT do (boundary with C and A)

- NO Forge port, NO push/PR, NO repo-source detection, NO `deliver` field — all change C; this change
  only STORES + manages + validates credentials and exposes the self-hosted registry.
- NO change to how users LOG IN (still GitHub OAuth) — multi-provider login is change A, next iteration.
- The owner-scoped RESOLUTION of a credential for a task (via the `task.created` audit event) is defined
  in C where it is consumed; this change provides the storage + lookup-by-(user,kind,host) primitive.

## Decisions to ratify
- PAT-paste v1 (vs OAuth) — recommended, baked.
- Per-user credential (vs a deployment-bot single service account) — per-user baked; deployment-bot
  fallback is a future option, surfaced when C resolves a credential.
- Forge calls are TRUSTED native-fetch to the operator's connected forge — NOT SSRF-gated;
  `assertSafeProviderUrl` is unchanged + untouched (scoped to the compatible-provider gateway). So
  internal self-hosted forges work by a plain native fetch (no private-IP question); cross-network
  reachability is the self-deployer's responsibility. (Simplified from the earlier SSRF-allowlist apparatus.)
- `githubAccessToken` encryption: done this iteration as a simple full re-encrypt sweep (no legacy data to
  preserve), all THREE readers decrypt via one helper, boot fail-fast on missing key.
