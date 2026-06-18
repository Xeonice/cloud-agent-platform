/**
 * ClaudeAuthSource port (add-claude-code-runtime, design D3 / task 2.3) — supplies
 * the Claude Code authentication material the runtime injects into each per-task
 * sandbox BEFORE claude launches. Mirrors {@link CodexAuthSource}.
 *
 * Claude's auth path is SIMPLER than codex's auth.json: a single OAuth
 * subscription token (minted on a workstation via `claude setup-token`) is
 * exported as the `CLAUDE_CODE_OAUTH_TOKEN` env var on the launch environment —
 * NOT written to a file. `ClaudeCodeRuntime.injectAuth()` consumes the resolved
 * token; the launch path additionally UNSETS `ANTHROPIC_API_KEY`/
 * `ANTHROPIC_AUTH_TOKEN`/`apiKeyHelper`, because a non-empty value silently
 * shadows the OAuth token.
 *
 * Like the codex source this is a dedicated DEPLOYMENT-level port: the encrypted
 * settings card / per-user DB store is deferred to after the settings redesign,
 * so the env-backed {@link EnvClaudeAuthSource} is the only implementation this
 * change ships. A later DB-backed source satisfies the SAME port with no runtime
 * change.
 *
 * SECRET BOUNDARY: the token is exposed ONLY to `injectAuth`; the
 * {@link ClaudeAuthSource.configured} fact is the only thing any read-back/status
 * path (the `/runtimes` readiness endpoint) may observe — never the token value
 * or a suffix.
 */
export interface ClaudeAuthMaterial {
  /**
   * The Claude OAuth subscription token, exported as `CLAUDE_CODE_OAUTH_TOKEN` on
   * the sandbox launch environment. Carried verbatim; never logged or echoed on a
   * status path.
   */
  readonly oauthToken: string;
}

/**
 * Resolves the Claude auth material to inject for a provisioning sandbox, or
 * `null` when none is configured. A `claude-code` task with a `null` result
 * FAILS CLOSED (a distinct "runtime not configured" reason) rather than launching
 * unauthenticated — the deliberate divergence from codex, which degrades to
 * unauthenticated. {@link configured} reports the same fact WITHOUT exposing the
 * token, for the readiness probe.
 */
export interface ClaudeAuthSource {
  /** Resolve the OAuth token to inject, or `null` when none is configured. */
  getClaudeAuth(): Promise<ClaudeAuthMaterial | null>;
  /**
   * Whether a Claude token is configured — a BOOLEAN only, no secret. Backs the
   * `/runtimes` readiness probe so the console can disable an unconfigured runtime
   * before task creation.
   */
  configured(): Promise<boolean>;
}

/**
 * DI token for the {@link ClaudeAuthSource} port. Consumers inject the source by
 * this token so the env-backed implementation can later be swapped for a
 * settings/DB-backed one with no consumer change.
 */
export const CLAUDE_AUTH_SOURCE = Symbol('ClaudeAuthSource');
