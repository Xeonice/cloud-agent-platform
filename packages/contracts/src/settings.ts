import { z } from 'zod';

/**
 * Account settings + Codex credential contract (account-settings spec).
 *
 * Two strictly separate concepts live here:
 *  - {@link AccountSettingsSchema}: per-account console preferences (default repo,
 *    retention window, destructive-write gate) plus the read-only console account
 *    display identity.
 *  - {@link CodexCredentialSchema}: the Codex *execution* credential
 *    ("任务运行用什么模型"), a concept entirely distinct from the console login
 *    identity ("谁能进控制台"). Connecting/clearing it never touches account
 *    enablement or login methods.
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
 * Default system-wide task slot ceiling applied when no value has been
 * persisted and env `MAX_CONCURRENT_TASKS` is unset.
 */
export const DEFAULT_MAX_CONCURRENT_TASKS = 5;

/**
 * The SYSTEM-LEVEL (instance-wide, shared across all accounts) task slot
 * ceiling — how many tasks may run concurrently. Constrained to an integer in
 * 1–20 (default {@link DEFAULT_MAX_CONCURRENT_TASKS}) so an out-of-range or
 * non-integer value is rejected by the settings update API without mutating
 * the stored value or the live semaphore. Floor ≥ 1 is mandatory: a ceiling of
 * 0 would starve the queue.
 */
export const MaxConcurrentTasksSchema = z.number().int().min(1).max(20);
export type MaxConcurrentTasks = z.infer<typeof MaxConcurrentTasksSchema>;

/**
 * Per-account console preferences (read shape).
 *
 * `allowedAccount` is the read-only console account display identity
 * (e.g. an email or handle), derived solely from the authenticated session and
 * NOT writable through the update API — "who can log into the console" is
 * governed by account administration, not by editable preferences.
 *
 * `defaultRepoId` references an imported repo by id and is NULLABLE (no default
 * selected). `defaultSandboxEnvironmentId` references the user's preferred task
 * startup image/environment and is NULLABLE (fall back to deployment default).
 * `retention` is the audit retention window in days. `writeConfirm` is the
 * destructive-action gate toggle ("破坏性写入前停止").
 */
export const AccountSettingsSchema = z.object({
  /** Read-only console account display identity, sourced from the session. */
  allowedAccount: z.string().min(1),
  /** Selected default repository (FK to an imported repo), or null when unset. */
  defaultRepoId: z.string().uuid().nullable(),
  /** User-scoped default task startup image/environment, or null when unset. */
  defaultSandboxEnvironmentId: z.string().uuid().nullable().default(null),
  /** History/audit retention window in days. */
  retention: RetentionDaysSchema,
  /** Destructive-action gate toggle ("破坏性写入前停止" / write-confirm). */
  writeConfirm: z.boolean(),
  /**
   * SYSTEM-LEVEL task slot ceiling, shared across every account (NOT a
   * per-account preference — a write by one operator is observed by all).
   * Optional on the wire for backward compatibility; defaults to
   * {@link DEFAULT_MAX_CONCURRENT_TASKS} when absent.
   */
  maxConcurrentTasks: MaxConcurrentTasksSchema.default(
    DEFAULT_MAX_CONCURRENT_TASKS,
  ),
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
  /** New user-scoped default task startup image/environment, or null to clear it. */
  defaultSandboxEnvironmentId: z.string().uuid().nullable().optional(),
  /** New audit retention window in days (constrained to the allowed set). */
  retention: RetentionDaysSchema.optional(),
  /** New destructive-action gate toggle value. */
  writeConfirm: z.boolean().optional(),
  /**
   * New SYSTEM-LEVEL task slot ceiling (integer 1–20, shared across accounts).
   * Omit to leave the current ceiling unchanged; out-of-range or non-integer
   * values are rejected (400) without mutating the stored value or the live
   * semaphore.
   */
  maxConcurrentTasks: MaxConcurrentTasksSchema.optional(),
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
export const SaveCodexCredentialRequestSchema = z
  .object({
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
  })
  /**
   * A compatible-provider save REQUIRES a non-null base URL (task 2.3): the base
   * URL is not secret and — unlike the apiKey — is never preserved-by-omission on
   * a compatible re-save (`projectCredentialSave` nulls it when absent), so a
   * compatible save without one would persist a provider that codex cannot reach
   * and the discovery/execution SSRF guard cannot validate. Rejected at the wire
   * (the api pipe + the service re-check) BEFORE any write. The official path is
   * unconstrained (it carries no base URL).
   */
  .superRefine((value, ctx) => {
    if (value.mode === 'compatible' && !value.baseUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['baseUrl'],
        message: 'A compatible-provider save requires a base URL.',
      });
    }
  });
export type SaveCodexCredentialRequest = z.infer<
  typeof SaveCodexCredentialRequestSchema
>;

// ---------------------------------------------------------------------------
// Claude Code runtime credential (pixel-restore-console-to-od Track 3 /
// account-settings "Claude Code runtime credential") — the runtime sibling of
// the Codex credential, distinct from it and from console login. Same secret
// discipline: ciphertext + masked suffix only; plaintext is never returned.
// ---------------------------------------------------------------------------

/**
 * The two mutually-exclusive Claude Code credential modes:
 *  - `subscription`: a Claude OAuth token minted via `claude setup-token`
 *    (exported as `CLAUDE_CODE_OAUTH_TOKEN` to the sandbox) — the path the
 *    runtime consumes today.
 *  - `api_key`: an Anthropic `sk-ant-` API key (usage-based billing).
 */
export const ClaudeCredentialModeSchema = z.enum(['subscription', 'api_key']);
export type ClaudeCredentialMode = z.infer<typeof ClaudeCredentialModeSchema>;

/** Connection state, same vocabulary as the Codex credential. */
export const ClaudeCredentialStateSchema = z.enum([
  'not_connected',
  'not_saved',
  'connected',
]);
export type ClaudeCredentialState = z.infer<typeof ClaudeCredentialStateSchema>;

/**
 * Claude Code credential READ shape. Neither secret is ever returned: each is
 * represented only by a non-reversible presence boolean and an optional masked
 * suffix for display.
 */
export const ClaudeCredentialSchema = z.object({
  /** Active mode. */
  mode: ClaudeCredentialModeSchema,
  /** Connection state shared across the status card / tab subtitle. */
  state: ClaudeCredentialStateSchema,
  /** Non-reversible presence indicator for the stored `setup-token`. */
  hasSetupToken: z.boolean(),
  /** Optional masked suffix of the stored setup-token (display only). */
  setupTokenSuffix: z.string().min(1).nullable().optional(),
  /** Non-reversible presence indicator for the stored Anthropic API key. */
  hasApiKey: z.boolean(),
  /** Optional masked suffix of the stored API key (display only). */
  apiKeySuffix: z.string().min(1).nullable().optional(),
  /** Selected default Claude model persisted with the credential (non-secret). */
  defaultModel: z.string().min(1).nullable().optional(),
});
export type ClaudeCredential = z.infer<typeof ClaudeCredentialSchema>;

/**
 * Body accepted when saving a Claude Code credential. The secrets (`setupToken`,
 * `apiKey`) are WRITE-ONLY: encrypted at rest on save, never echoed back, and
 * preserved-by-omission on an update of the same mode. Saving one mode clears the
 * other mode's secret (the modes are mutually exclusive).
 */
export const SaveClaudeCredentialRequestSchema = z.object({
  /** Mode being saved. */
  mode: ClaudeCredentialModeSchema,
  /**
   * Write-only `claude setup-token` token (subscription mode). Encrypted at rest;
   * omit to preserve the previously stored token on a subscription re-save.
   */
  setupToken: z.string().min(1).optional(),
  /**
   * Write-only Anthropic API key (api_key mode). Encrypted at rest; omit to
   * preserve the previously stored key on an api_key re-save.
   */
  apiKey: z.string().min(1).optional(),
  /** Selected default model to persist with the credential. */
  defaultModel: z.string().min(1).optional(),
});
export type SaveClaudeCredentialRequest = z.infer<
  typeof SaveClaudeCredentialRequestSchema
>;

// ---------------------------------------------------------------------------
// Compatible-provider model discovery (POST /settings/codex/models)
// ---------------------------------------------------------------------------

/**
 * Body for the candidate model-discovery probe.
 *
 * A base URL + key are supplied so a compatible provider can be validated
 * BEFORE persisting; nothing is stored. The `apiKey` is used only as the
 * provider Authorization bearer and is never logged or returned. Lifted into
 * the shared contract so the API pipe and the web `discoverCodexModels` client
 * validate against ONE shape.
 */
export const DiscoverModelsRequestSchema = z.object({
  /** Compatible-provider base URL to probe (validated for SSRF safety server-side). */
  baseUrl: z.string().url(),
  /** Write-only candidate API key, used only as the probe Authorization bearer. */
  apiKey: z.string().min(1),
});
export type DiscoverModelsRequest = z.infer<typeof DiscoverModelsRequestSchema>;

/**
 * A distinguishable model-discovery failure code surfaced to the console so the
 * dialog can render the actual outcome class (blocked vs auth-failure vs
 * unreachable vs malformed) rather than a generic error:
 *  - `provider_url_blocked`: the operator-supplied Base URL was rejected by the
 *    server-side SSRF guard BEFORE any outbound request (bad scheme, or a host
 *    that resolves to loopback/private/link-local/cloud-metadata). No fetch was
 *    made — it is a configuration error, not a provider failure.
 *  - `provider_auth_failed`: the provider rejected the credential (HTTP 401/403).
 *  - `provider_unreachable`: the provider could not be reached (network/DNS/
 *    timeout) or returned a non-2xx (incl. 5xx) status.
 *  - `provider_bad_response`: reached the provider but the response was not a
 *    parseable model list.
 *
 * NOTE: `provider_url_blocked` is the integration point between the contract
 * (this lifted shape) and the discovery-hardening SSRF guard — the api's
 * `model-discovery.client.ts` emits it, so the shared schema must accept it or
 * the web client's `DiscoverModelsResponseSchema.parse` would reject a clean
 * blocked outcome as a malformed transport response.
 */
export const ModelDiscoveryErrorCodeSchema = z.enum([
  'provider_url_blocked',
  'provider_auth_failed',
  'provider_unreachable',
  'provider_bad_response',
]);
export type ModelDiscoveryErrorCode = z.infer<
  typeof ModelDiscoveryErrorCodeSchema
>;

/**
 * Response to the model-discovery probe (no persistence). A discriminated union
 * on `ok`:
 *  - success ⇒ `{ ok: true, models }` — the selectable model ids the provider
 *    reported (an empty list is a valid success, not an error).
 *  - failure ⇒ `{ ok: false, error, message }` — a distinguishable error code
 *    plus a human-readable, secret-free message.
 *
 * Shared so the controller's return type and the web client decode ONE shape.
 */
export const DiscoverModelsResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    /** The available model ids the provider reported (may be empty). */
    models: z.array(z.string()),
  }),
  z.object({
    ok: z.literal(false),
    /** Distinguishable failure code for the dialog's outcome class. */
    error: ModelDiscoveryErrorCodeSchema,
    /** Human-readable, secret-free failure detail. */
    message: z.string(),
  }),
]);
export type DiscoverModelsResponse = z.infer<
  typeof DiscoverModelsResponseSchema
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

// ---------------------------------------------------------------------------
// MCP server enable toggle (system-level, admin-gated)
// ---------------------------------------------------------------------------

/**
 * Default for the SYSTEM-LEVEL MCP-server enable flag. `false` so the platform
 * ships INERT — the outward-facing sandbox-execution surface stays off until a
 * deliberate admin enable (remote-mcp-server spec, D5).
 */
export const DEFAULT_MCP_SERVER_ENABLED = false;

/**
 * The SYSTEM-LEVEL (instance-wide, shared across all accounts) flag gating
 * whether the `/mcp` endpoint serves MCP traffic. Persisted on the existing
 * `SystemSettings` (like {@link MaxConcurrentTasksSchema}) and toggled only by an
 * admin operator. When `false`, `/mcp` is inert (no `mcp_` token resolves a
 * usable session there) and the console hides the connect affordance; turning it
 * off stops new use WITHOUT deleting any minted token.
 */
export const McpServerEnabledSchema = z.boolean();
export type McpServerEnabled = z.infer<typeof McpServerEnabledSchema>;

/**
 * READ shape for the admin-gated MCP-server settings surface: the current
 * system-level `mcpServerEnabled` flag. Defaults to
 * {@link DEFAULT_MCP_SERVER_ENABLED} when no value has been persisted, so the
 * console renders the off-by-default state without a separate probe.
 */
export const McpServerSettingsSchema = z.object({
  /** Whether the `/mcp` endpoint currently serves MCP traffic. */
  mcpServerEnabled: McpServerEnabledSchema.default(DEFAULT_MCP_SERVER_ENABLED),
});
export type McpServerSettings = z.infer<typeof McpServerSettingsSchema>;

/**
 * Body accepted by the admin-gated MCP-server settings update endpoint.
 *
 * Carries only the writable system-level `mcpServerEnabled` flag. The write is
 * admin-gated server-side (mirroring the existing admin-gated settings pattern);
 * a non-admin session or a machine principal is rejected (403) without mutating
 * the stored flag.
 */
export const UpdateMcpServerSettingsRequestSchema = z.object({
  /** New system-level MCP-server enable flag. */
  mcpServerEnabled: McpServerEnabledSchema,
});
export type UpdateMcpServerSettingsRequest = z.infer<
  typeof UpdateMcpServerSettingsRequestSchema
>;

// ---------------------------------------------------------------------------
// Forge (code-hosting) connection credentials (add-forge-credentials)
// ---------------------------------------------------------------------------

/**
 * The forge a credential targets. A forge credential is the token used to
 * clone/push + open a PR/MR on the operator's OWN connected forge — a concept
 * entirely distinct from console login ("谁能进控制台").
 */
export const ForgeKindSchema = z.enum(['github', 'gitlab', 'gitee']);
export type ForgeKind = z.infer<typeof ForgeKindSchema>;

/** Connection state of a forge credential. */
export const ForgeCredentialStateSchema = z.enum(['not_connected', 'connected']);
export type ForgeCredentialState = z.infer<typeof ForgeCredentialStateSchema>;

/**
 * Whether the saved token has been proven usable for forge API reads.
 *
 * `unverified` still means the git credential is connected and may be used for
 * clone/push. It only says the API probe/listing path could not be proven (common
 * for internal Gitee tokens that grant git clone/push but deny repo-list APIs).
 */
export const ForgeCredentialApiAccessSchema = z.enum(['verified', 'unverified']);
export type ForgeCredentialApiAccess = z.infer<
  typeof ForgeCredentialApiAccessSchema
>;

/**
 * Forge credential READ shape (secret-free). The token is NEVER returned: only
 * `kind`, the forge `host`, the connection `state`, and an optional masked
 * `last4` suffix for display. `apiAccess` is non-secret status describing the
 * repo-list/API probe only; `unverified` credentials remain connected for git
 * clone/push. There is intentionally NO plaintext token field.
 */
export const ForgeCredentialSchema = z.object({
  /** Forge kind. */
  kind: ForgeKindSchema,
  /** Forge host (public well-known host, or a self-hosted host). */
  host: z.string().min(1),
  /** Connection state. */
  state: ForgeCredentialStateSchema,
  /** API/listing validation status. Optional for backward-compatible reads. */
  apiAccess: ForgeCredentialApiAccessSchema.optional(),
  /** Optional masked suffix of the stored token for display only. */
  last4: z.string().min(1).nullable().optional(),
});
export type ForgeCredential = z.infer<typeof ForgeCredentialSchema>;

/** Response body for `GET /settings/forges` — the operator's connected forges. */
export const ListForgeCredentialsResponseSchema = z.array(ForgeCredentialSchema);
export type ListForgeCredentialsResponse = z.infer<
  typeof ListForgeCredentialsResponseSchema
>;

/**
 * Connect-a-forge write body: the operator pastes a Personal Access Token for a
 * forge. `host` is optional — omitted for a public forge (defaults to the
 * well-known public host for `kind`); supplied for a self-hosted instance (which
 * must already be registered as a `ForgeConnection`). The plaintext `token` is
 * accepted only here and is never stored or returned in plaintext.
 */
export const ConnectForgeCredentialRequestSchema = z.object({
  /** Forge kind. */
  kind: ForgeKindSchema,
  /** Self-hosted host; omitted for a public forge. */
  host: z.string().min(1).optional(),
  /** The Personal Access Token (plaintext, write-only). */
  token: z.string().min(1),
});
export type ConnectForgeCredentialRequest = z.infer<
  typeof ConnectForgeCredentialRequestSchema
>;

/**
 * A registered self-hosted forge connection (deployment-level infra config):
 * maps a `host` to its forge `kind` + API base. Public hosts need no row.
 */
export const ForgeConnectionSchema = z.object({
  /** Self-hosted forge host, e.g. git.corp.com. */
  host: z.string().min(1),
  /** Forge kind. */
  kind: ForgeKindSchema,
  /** API base, e.g. https://git.corp.com/api/v4. */
  apiBaseUrl: z.string().url(),
  /** Cached GitLab numeric project id; optional. */
  projectId: z.string().min(1).nullable().optional(),
});
export type ForgeConnection = z.infer<typeof ForgeConnectionSchema>;

/**
 * A repository the connected forge credential can access (the import picker shape,
 * add-multi-forge-task-delivery). Returned by the per-forge listing.
 */
export const AvailableForgeRepoSchema = z.object({
  /** Source forge. */
  forge: ForgeKindSchema,
  /** `owner/name` (github/gitee) or `namespace/project` (gitlab). */
  fullPath: z.string().min(1),
  /** The https clone URL. */
  gitSource: z.string().min(1),
  /** Repository visibility. */
  visibility: z.string().min(1),
  /** Default branch. */
  defaultBranch: z.string().min(1),
  /** GitLab numeric project id (cache), when known. */
  gitlabProjectId: z.string().min(1).optional(),
});
export type AvailableForgeRepo = z.infer<typeof AvailableForgeRepoSchema>;

/** Response body for the per-forge import picker listing. */
export const ListAvailableForgeReposResponseSchema = z.array(AvailableForgeRepoSchema);
export type ListAvailableForgeReposResponse = z.infer<
  typeof ListAvailableForgeReposResponseSchema
>;

/** Register-a-self-hosted-forge write body. */
export const RegisterForgeConnectionRequestSchema = z.object({
  /** Self-hosted forge host. */
  host: z.string().min(1),
  /** Forge kind. */
  kind: ForgeKindSchema,
  /**
   * API base. Optional — when omitted the server derives `https://{host}/api/v{N}`
   * from the kind (`/api/v3` GHE, `/api/v4` GitLab, `/api/v5` Gitee).
   */
  apiBaseUrl: z.string().url().optional(),
});
export type RegisterForgeConnectionRequest = z.infer<
  typeof RegisterForgeConnectionRequestSchema
>;

// ---------------------------------------------------------------------------
// Admin-managed SMTP configuration (add-smtp-config-ui)
//
// A single deployment-level (NOT per-user) outbound SMTP configuration an admin
// manages from the console. Same secret discipline as the credentials above: the
// SMTP password is WRITE-ONLY — accepted on save for encryption at rest, NEVER
// returned by any read shape. Reads expose only the non-secret tuple plus a
// non-reversible `hasPassword` presence flag and an optional masked `passLast4`
// suffix. There is intentionally NO plaintext password field on any READ schema.
// ---------------------------------------------------------------------------

/**
 * SMTP configuration READ shape (secret-free, masked).
 *
 * Returns the non-secret tuple (`host`/`port`/`user`/`from`) plus a masked
 * password indicator: `hasPassword` is a non-reversible presence flag and
 * `passLast4` is an optional masked suffix for display only. The plaintext
 * password is NEVER on this schema.
 */
export const SmtpConfigReadSchema = z.object({
  /** SMTP server host (non-secret), e.g. `smtp.resend.com`. */
  host: z.string().min(1),
  /** SMTP server port (non-secret), e.g. `465`. */
  port: z.number().int().min(1).max(65535),
  /** SMTP auth username (non-secret), e.g. `resend`. */
  user: z.string().min(1),
  /** Sender (From) address used for outbound mail (non-secret). */
  from: z.string().min(1),
  /** Non-reversible presence indicator for the stored password. Never the password. */
  hasPassword: z.boolean(),
  /** Optional masked suffix of the stored password for display (e.g. last 4 chars). */
  passLast4: z.string().min(1).nullable().optional(),
});
export type SmtpConfigRead = z.infer<typeof SmtpConfigReadSchema>;

/**
 * Body accepted when an admin saves the SMTP configuration.
 *
 * The `pass` (SMTP password / Resend API Key) is WRITE-ONLY: it is accepted here
 * for encryption-at-rest on save and is NEVER returned by any read shape. Omit
 * `pass` on an update to preserve the previously stored encrypted password rather
 * than clearing it (the dialog's "留空沿用" affordance). The non-secret
 * `host`/`port`/`user`/`from` tuple is always persisted as supplied.
 */
export const SaveSmtpConfigRequestSchema = z.object({
  /** SMTP server host (non-secret), e.g. `smtp.resend.com`. */
  host: z.string().min(1),
  /** SMTP server port (non-secret), e.g. `465`. */
  port: z.number().int().min(1).max(65535),
  /** SMTP auth username (non-secret), e.g. `resend`. */
  user: z.string().min(1),
  /** Sender (From) address used for outbound mail (non-secret). */
  from: z.string().min(1),
  /**
   * Write-only plaintext SMTP password (the Resend API Key). Encrypted at rest on
   * save and never echoed back. Omit to preserve the previously stored password.
   */
  pass: z.string().min(1).optional(),
});
export type SaveSmtpConfigRequest = z.infer<typeof SaveSmtpConfigRequestSchema>;

/**
 * Body accepted by the SMTP test-send endpoint (`POST /settings/smtp/test`).
 *
 * Mirrors the Codex "discover models" probe (D5): the test sends a real email to
 * the requesting admin's OWN session email to verify connectivity WITHOUT trusting
 * persisted state. All fields are optional — when supplied they exercise the
 * SUBMITTED candidate configuration (nothing persisted on failure); when omitted
 * the server falls back to the currently SAVED configuration. The `pass` here is
 * write-only and is never logged or returned.
 */
export const TestSmtpConfigRequestSchema = z.object({
  /** Candidate SMTP server host; omit to use the saved config. */
  host: z.string().min(1).optional(),
  /** Candidate SMTP server port; omit to use the saved config. */
  port: z.number().int().min(1).max(65535).optional(),
  /** Candidate SMTP auth username; omit to use the saved config. */
  user: z.string().min(1).optional(),
  /** Candidate sender (From) address; omit to use the saved config. */
  from: z.string().min(1).optional(),
  /** Write-only candidate password; omit to use the saved (encrypted) password. */
  pass: z.string().min(1).optional(),
});
export type TestSmtpConfigRequest = z.infer<typeof TestSmtpConfigRequestSchema>;

/**
 * Response to the SMTP test-send (no persistence side effect). A simple
 * `{ ok, message }` outcome: `ok` reports whether the test email was sent and
 * `message` is a human-readable, secret-free detail (success confirmation or the
 * failure reason). The password is NEVER included.
 */
export const TestSmtpConfigResponseSchema = z.object({
  /** Whether the test email was sent successfully. */
  ok: z.boolean(),
  /** Human-readable, secret-free outcome detail (success or failure reason). */
  message: z.string(),
});
export type TestSmtpConfigResponse = z.infer<
  typeof TestSmtpConfigResponseSchema
>;
