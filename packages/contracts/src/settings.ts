import { z } from 'zod';

/**
 * Account settings + Codex credential contract (account-settings spec).
 *
 * Two strictly separate concepts live here:
 *  - {@link AccountSettingsSchema}: per-account console preferences (default repo,
 *    retention window, destructive-write gate) plus the read-only allowlisted
 *    account display identity sourced from the OAuth identity.
 *  - {@link CodexCredentialSchema}: the Codex *execution* credential
 *    ("任务运行用什么模型"), a concept entirely distinct from the console login
 *    identity ("谁能进控制台"). Connecting/clearing it never touches OAuth identity
 *    or allowlist membership.
 *
 * Secret discipline: the compatible-provider API key is WRITE-ONLY. It is
 * accepted on the save request but NEVER returned by any read shape — reads
 * expose only a non-reversible presence indicator (`hasApiKey`) and an optional
 * masked suffix. There is intentionally no plaintext key field on any READ
 * schema below.
 */

// ---------------------------------------------------------------------------
// Account preferences (console-side)
// ---------------------------------------------------------------------------

/**
 * The history/audit retention window in days. Constrained to the allowed set so
 * an out-of-range value is rejected by the settings update API without mutating
 * any stored preference.
 */
export const RetentionDaysSchema = z.union([
  z.literal(7),
  z.literal(30),
  z.literal(90),
  z.literal(180),
]);
export type RetentionDays = z.infer<typeof RetentionDaysSchema>;

/**
 * Per-account console preferences (read shape).
 *
 * `allowedAccount` is the read-only allowlisted account display identity
 * (e.g. `tanghehui`), derived solely from the OAuth identity and NOT writable
 * through the update API — "who can log into the console" is governed by the
 * multi-user-oauth allowlist, not by editable preferences.
 *
 * `defaultRepoId` references an imported repo by id and is NULLABLE (no default
 * selected). `retention` is the audit retention window in days. `writeConfirm`
 * is the destructive-action gate toggle ("破坏性写入前停止").
 */
export const AccountSettingsSchema = z.object({
  /** Read-only allowlisted account display identity, sourced from OAuth. */
  allowedAccount: z.string().min(1),
  /** Selected default repository (FK to an imported repo), or null when unset. */
  defaultRepoId: z.string().uuid().nullable(),
  /** History/audit retention window in days. */
  retention: RetentionDaysSchema,
  /** Destructive-action gate toggle ("破坏性写入前停止" / write-confirm). */
  writeConfirm: z.boolean(),
});
export type AccountSettings = z.infer<typeof AccountSettingsSchema>;

// ---------------------------------------------------------------------------
// Codex credential (execution-side)
// ---------------------------------------------------------------------------

/**
 * The two mutually-exclusive Codex credential provider modes:
 *  - `official`: an official-account connection (connection state + non-secret
 *    metadata only; no base URL or API key).
 *  - `compatible`: a compatible-provider connection (base URL + API key +
 *    optional selected default model).
 */
export const CodexCredentialModeSchema = z.enum(['official', 'compatible']);
export type CodexCredentialMode = z.infer<typeof CodexCredentialModeSchema>;

/**
 * The connection state surfaced so the settings status card, the active tab
 * subtitle, and the provider pill all render the same condition:
 *  - `not_connected`: nothing connected for this mode.
 *  - `not_saved`: details entered (e.g. a base URL) but not yet successfully
 *    saved ("未保存").
 *  - `connected`: a valid credential is saved/connected.
 */
export const CodexCredentialStateSchema = z.enum([
  'not_connected',
  'not_saved',
  'connected',
]);
export type CodexCredentialState = z.infer<typeof CodexCredentialStateSchema>;

/**
 * Codex credential READ shape.
 *
 * Returns the active `mode` and a connection `state` consumed consistently by
 * the status card / tab subtitle / provider pill. For compatible mode, the
 * non-secret `baseUrl` and the selected `defaultModel` are returned in
 * plaintext (they are not secret).
 *
 * The API key is NEVER returned: `hasApiKey` is a non-reversible presence
 * indicator and `apiKeySuffix` is an optional masked suffix for display only.
 * There is intentionally NO plaintext key field on this schema.
 */
export const CodexCredentialSchema = z.object({
  /** Active provider mode. */
  mode: CodexCredentialModeSchema,
  /** Connection state shared across status card, tab subtitle, and provider pill. */
  state: CodexCredentialStateSchema,
  /** Compatible-provider base URL (non-secret). Null/absent for official mode. */
  baseUrl: z.string().url().nullable().optional(),
  /** Non-reversible presence indicator for the stored API key. Never the key itself. */
  hasApiKey: z.boolean(),
  /** Optional masked suffix of the stored key for display (e.g. last 4 chars). */
  apiKeySuffix: z.string().min(1).nullable().optional(),
  /** Selected default model persisted with the credential (non-secret). */
  defaultModel: z.string().min(1).nullable().optional(),
});
export type CodexCredential = z.infer<typeof CodexCredentialSchema>;

// ---------------------------------------------------------------------------
// Write request bodies
// ---------------------------------------------------------------------------

/**
 * Body accepted by the settings update API (PATCH/PUT).
 *
 * Only writable preferences are present; the read-only `allowedAccount` display
 * identity is intentionally absent and SHALL NOT be writable. All fields are
 * optional so a partial update mutates only the supplied keys. `defaultRepoId`
 * is accepted only when it references a repo the account has imported (enforced
 * server-side); passing `null` clears the selection.
 */
export const UpdateSettingsRequestSchema = z.object({
  /** New default repository selection, or null to clear it. */
  defaultRepoId: z.string().uuid().nullable().optional(),
  /** New audit retention window in days (constrained to the allowed set). */
  retention: RetentionDaysSchema.optional(),
  /** New destructive-action gate toggle value. */
  writeConfirm: z.boolean().optional(),
});
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequestSchema>;

/**
 * Body accepted when saving a Codex credential.
 *
 * The `apiKey` is WRITE-ONLY: it is accepted here for encryption-at-rest on
 * save and is NEVER returned by any read shape. Omitting `apiKey` on update
 * preserves the previously stored encrypted key rather than clearing it.
 *
 * For `official` mode, the ChatGPT login state is provided as `authJson` (the
 * `~/.codex/auth.json` from `codex login`) and `baseUrl`/`apiKey`/`defaultModel`
 * are unused. For `compatible` mode, `baseUrl` identifies the provider,
 * `defaultModel` is the selected default (both non-secret), and `apiKey` is the
 * write-only secret.
 */
export const SaveCodexCredentialRequestSchema = z.object({
  /** Provider mode being saved. */
  mode: CodexCredentialModeSchema,
  /** Compatible-provider base URL. */
  baseUrl: z.string().url().optional(),
  /**
   * Write-only plaintext API key. Encrypted at rest on save and never echoed
   * back. Omit to preserve the previously stored key on update.
   */
  apiKey: z.string().min(1).optional(),
  /**
   * Write-only OFFICIAL-mode ChatGPT login state — the full `~/.codex/auth.json`
   * document produced by `codex login` (`{auth_mode:"chatgpt", tokens:{…}}`).
   * Encrypted at rest on save and NEVER echoed back; the sandbox provider reads
   * the decrypted value to authenticate codex per task (replacing the
   * deployment-level env injection). Omit to preserve the previously stored
   * login on an official-mode re-save.
   */
  authJson: z.string().min(1).optional(),
  /** Selected default model to persist with the credential. */
  defaultModel: z.string().min(1).optional(),
});
export type SaveCodexCredentialRequest = z.infer<
  typeof SaveCodexCredentialRequestSchema
>;

// ---------------------------------------------------------------------------
// Official ChatGPT connect — OAuth device-code flow
// ---------------------------------------------------------------------------

/**
 * Response to STARTING an official-account device-code login. The server runs
 * `codex login --device-auth` in a transient sandbox and surfaces the OpenAI
 * verification URL + one-time code; the operator authorizes in their browser
 * (signed into ChatGPT), then the client polls {@link CodexDeviceLoginStatus}
 * until codex receives the tokens and the server stores them encrypted. No
 * secret is in this response — only the public verification URL + user code.
 */
export const CodexDeviceLoginStartResponseSchema = z.object({
  /** OpenAI's device verification URL the operator opens (e.g. https://auth.openai.com/codex/device). */
  verificationUri: z.string().url(),
  /** The one-time code the operator enters at the verification URL. */
  userCode: z.string().min(1),
  /** Seconds until the code expires (codex's device codes last ~15 minutes). */
  expiresInSeconds: z.number().int().positive().optional(),
});
export type CodexDeviceLoginStartResponse = z.infer<
  typeof CodexDeviceLoginStartResponseSchema
>;

/**
 * Poll status of an in-flight device-code login:
 *  - `awaiting_authorization`: code issued, waiting for the operator to authorize.
 *  - `connected`: codex received the tokens; the credential is now stored.
 *  - `expired`: the code/window lapsed before authorization.
 *  - `error`: the login could not start/complete (e.g. device-auth not enabled).
 * The verification URL + user code are echoed back while awaiting so a client
 * that polls fresh (no start response) can still render them.
 */
export const CodexDeviceLoginStatusSchema = z.object({
  status: z.enum(['awaiting_authorization', 'connected', 'expired', 'error']),
  verificationUri: z.string().url().nullable().optional(),
  userCode: z.string().min(1).nullable().optional(),
  /** Human-readable detail for `error`/`expired` (never a secret). */
  message: z.string().nullable().optional(),
});
export type CodexDeviceLoginStatus = z.infer<typeof CodexDeviceLoginStatusSchema>;
