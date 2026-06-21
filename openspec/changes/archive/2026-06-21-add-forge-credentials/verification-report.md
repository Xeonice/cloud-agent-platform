# Verification Report — add-forge-credentials

Three-way adjudication of raw verify findings. Each raw-unmet requirement was
re-traced end-to-end against the actual code before routing.

## Reclassified MET (re-traced as satisfied despite skeptic refutation)

### The operator GitHub login token is encrypted at rest — MET

Re-traced end-to-end; the skeptic's own evidence confirms full satisfaction.

- **Write path** — `apps/api/src/auth/auth-session.service.ts:126` calls
  `storeMaybeEncrypted(accessToken)` before upserting `User.githubAccessToken`.
  When `CODEX_CRED_ENC_KEY` is configured this delegates to `encryptToStored`
  (AES-256-GCM; fresh 12-byte IV per call, 16-byte GCM auth tag,
  `ciphertext.iv.authTag` envelope — `apps/api/src/settings/settings-crypto.ts:124-141`).
- **ONE shared helper, ALL THREE readers** — every reader routes through the
  single `readMaybeEncrypted` helper (`apps/api/src/settings/secret-storage.ts:117`):
  `github-import.service.ts:221` (repo-import Bearer),
  `prisma-provision-lookup.ts:105` (clone-auth), and the login write path uses the
  sibling `storeMaybeEncrypted`. No reader 401s after encryption.
- **Boot fail-fast** — wired in `ForgeCredentialService.onModuleInit()` at
  `forge-credential.service.ts:71-72` via `assertEncryptionKeyValidIfConfigured()`,
  which throws on a configured-but-malformed key.
- **Schema** — `schema.prisma:174` (`User.githubAccessToken String?`) stores the
  envelope in place; never returned in plaintext on any read shape.

**Skeptic's caveat is NOT a violation.** The skeptic notes boot fail-fast does not
guard the absent-key case (only a malformed key). This is exactly what the spec
requires: requirement 4 says "fail fast at boot when this encryption **is enabled**
but no valid encryption key is set." An absent key means encryption is NOT enabled,
so the absent-key keyless-dev plaintext fallback (`secret-storage.ts:108`) is
explicitly sanctioned — spec.md: "it is plaintext today; this is orthogonal hygiene"
and design.md D5: "encrypt when a key is configured, else store plaintext (keyless
dev)." Encryption being conditional on the operator setting the env var is the
designed behavior, not a gap. **MET as written.**

## Gap / scope findings (folded, not routed to code tasks)

### Gap — migration sweep is a MAY, not a SHALL

The spec says the migration "MAY be a simple full re-encrypt sweep" and the
migration SQL comment acknowledges "re-encrypted by a full sweep at the app layer."
This is a MAY, not a SHALL — not a binding requirement. Requirement 4's SHALLs are:
ONE helper used by ALL THREE readers, boot fail-fast, and never returned in
plaintext — all of which are implemented (see above). No action.

### Scope — settings console UI (task 5.2) has no spec SHALL

The spec lists the "code-hosting connection" settings card as a DESIGN MOCKUP
handled in OpenDesign, "implemented alongside the settings surface (not blocking
the backend)." None of the four named spec requirements includes a UI-specific
SHALL; the UI is a task (5.2), not a spec requirement. Out of scope for spec
verification.

### Scope — behaviors implemented beyond any spec requirement (acceptable supersets)

These exist in code but map to no spec scenario; they are additive, not gaps:

1. `GET /settings/forge-connections` list endpoint
   (`apps/api/src/settings/settings.controller.ts:133`) — spec defines
   `ForgeConnection` only as a storage/lookup registry; no read-all scenario
   requires an HTTP list surface.
2. `DELETE /settings/forges` disconnect endpoint
   (`apps/api/src/settings/settings.controller.ts:115`) — spec scenarios cover
   connect, secret-free read, and cascade-delete-with-user, but specify no
   operator-initiated explicit disconnect.
3. `ForgeCredentialService.onModuleInit()` boot fail-fast for the forge PAT key
   (`apps/api/src/settings/forge-credential.service.ts:71`) — the spec's boot
   fail-fast is scoped to `User.githubAccessToken`; the forge PAT path is already
   fail-closed at `encryptToStored` call-time, so the extra module-init assert is
   an unspecified-but-harmless hardening.

## Tally

- Reopened code tasks: 0
- Spec defects: 0
- Reclassified MET: 1 (The operator GitHub login token is encrypted at rest)
