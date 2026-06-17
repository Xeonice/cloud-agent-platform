/**
 * CodexAuthSource port — supplies the codex authentication material that the
 * provider injects into each per-task sandbox BEFORE codex launches.
 *
 * WHY a dedicated port (and not the settings CodexCredential row): the
 * ChatGPT(official) login state — the access/refresh/id tokens codex needs — is
 * NOT persisted in settings. The `CodexCredential` row carries only connection
 * STATE for official mode; only `compatible` mode stores an `apiKey`. So the
 * official login state must come from a deployment-level source. This port
 * abstracts that source so the deployment-backed implementation
 * ({@link EnvCodexAuthSource}, reading a gitignored env var) can later be
 * replaced by a settings/multi-user-backed one with NO provider change.
 *
 * The resolved material is a DISCRIMINATED UNION on `kind`
 * (wire-compatible-provider-execution, design D2), so one port carries BOTH
 * codex auth shapes and the provider branches on `kind` rather than guessing:
 *   - {@link OfficialCodexAuthMaterial} (`kind:'official'`) — the ChatGPT login
 *     `auth.json` written verbatim to `/home/gem/.codex/auth.json` inside the
 *     sandbox (codex's auth-file location for the `gem` user it runs as). codex
 *     then authenticates on launch and refreshes its own tokens in-container;
 *     the file is zeroed before stop / discarded when the container is removed,
 *     so the login state never persists on a shared/host volume.
 *   - {@link CompatibleCodexAuthMaterial} (`kind:'compatible'`) — an
 *     operator-configured OpenAI-Responses-API-compatible provider. Its
 *     `baseUrl`/`apiKey`/`model` are written into `~/.codex/config.toml` as a
 *     `[model_providers.*]` block + top-level `model`/`model_provider` (NO
 *     `auth.json` — `auth.json`'s `OPENAI_API_KEY` serves only the built-in
 *     `openai` provider, not a custom one). Verified against the codex 0.131
 *     config reference (task 3.1).
 */
export interface OfficialCodexAuthMaterial {
  /** Discriminant: the ChatGPT(official) login path (writes `auth.json`). */
  readonly kind: 'official';
  /**
   * The full `~/.codex/auth.json` document to write into the sandbox, verbatim.
   * For official mode this is `{auth_mode:"chatgpt", tokens:{...}, last_refresh}`;
   * codex tolerates an additional top-level `OPENAI_API_KEY` field.
   */
  readonly authJson: string;
}

/**
 * Compatible-provider material: the DECRYPTED state needed to point codex at an
 * operator-configured OpenAI-Responses-API-compatible provider. Carried in plain
 * fields here (already decrypted by the source) because it is written into the
 * per-task container — which IS the trust boundary (codex-execution-not-gated) —
 * via the same base64-decode file-injection idiom as `config.toml`, never the
 * launch argv. The provider validates {@link baseUrl} with `assertSafeProviderUrl`
 * before writing it.
 */
export interface CompatibleCodexAuthMaterial {
  /** Discriminant: the compatible-provider path (writes a config.toml block). */
  readonly kind: 'compatible';
  /** The operator-saved provider Base URL codex's `base_url` points at. */
  readonly baseUrl: string;
  /** The DECRYPTED provider API key (delivered via `experimental_bearer_token`). */
  readonly apiKey: string;
  /** The operator-selected default model written as top-level `model`. */
  readonly model: string;
}

/**
 * The codex auth material to inject for a provisioning sandbox — a discriminated
 * union on `kind`. The provider branches on `kind`: `official` → write
 * `auth.json`; `compatible` → write a `[model_providers.*]` config.toml block and
 * NO `auth.json`.
 */
export type CodexAuthMaterial =
  | OfficialCodexAuthMaterial
  | CompatibleCodexAuthMaterial;

/**
 * Resolves the codex auth material to inject for a provisioning sandbox, or
 * `null` when none is configured — in which case the provider SKIPS injection
 * (logging a warning) and codex will run unauthenticated.
 *
 * OWNER-SCOPED resolution (design D3): the material is resolved for the task's
 * OWNING account, so `taskId` is threaded through — one operator's compatible
 * key is never used for another operator's tasks. A source with no per-task
 * notion (the deployment-level {@link EnvCodexAuthSource}) simply ignores it.
 */
export interface CodexAuthSource {
  getCodexAuth(taskId: string): Promise<CodexAuthMaterial | null>;
}

/**
 * DI token for the {@link CodexAuthSource} port. Consumers inject the source by
 * this token so the bound implementation (env-backed today) can be swapped with
 * no consumer change.
 */
export const CODEX_AUTH_SOURCE = Symbol('CodexAuthSource');
