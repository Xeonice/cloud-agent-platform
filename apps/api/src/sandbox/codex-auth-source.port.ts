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
 * The resolved {@link CodexAuthMaterial.authJson} is written verbatim to
 * `/home/gem/.codex/auth.json` inside the sandbox (codex's auth-file location for
 * the `gem` user it runs as). codex then authenticates on launch and refreshes
 * its own tokens in-container; the file is discarded when the per-task container
 * is `AutoRemove`d, so the login state never persists on a shared/host volume.
 */
export interface CodexAuthMaterial {
  /**
   * The full `~/.codex/auth.json` document to write into the sandbox, verbatim.
   * For official mode this is `{auth_mode:"chatgpt", tokens:{...}, last_refresh}`;
   * codex tolerates an additional top-level `OPENAI_API_KEY` field.
   */
  readonly authJson: string;
}

/**
 * Resolves the codex auth material to inject for a provisioning sandbox, or
 * `null` when none is configured — in which case the provider SKIPS injection
 * (logging a warning) and codex will run unauthenticated.
 */
export interface CodexAuthSource {
  getCodexAuth(): Promise<CodexAuthMaterial | null>;
}

/**
 * DI token for the {@link CodexAuthSource} port. Consumers inject the source by
 * this token so the bound implementation (env-backed today) can be swapped with
 * no consumer change.
 */
export const CODEX_AUTH_SOURCE = Symbol('CodexAuthSource');
