import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { AGENT_RUNTIME_IDS, type AgentRuntimeId } from '@cap/contracts';

import {
  CLAUDE_AUTH_SOURCE,
  type ClaudeAuthSource,
} from '@/sandbox/claude-auth-source.port';

/**
 * Per-runtime readiness fact surfaced by `GET /runtimes` (add-claude-code-runtime
 * Track 3, task 3.3 / agent-runtime "Runtime readiness endpoint"). BOOLEANS ONLY —
 * `ready` reports whether the runtime's credential is configured so the create
 * dialog can OFFER or DISABLE the runtime before a task is created, WITHOUT ever
 * leaking the token value or any suffix of it.
 *
 * Mirrors the contract shape (`packages/contracts`). The id used to be a local
 * literal union, added as a fallback "even before the contract type is wired
 * through"; the contract landed and this stayed, so it was a fifth independent
 * statement of which runtimes exist — and a silent one, because a narrower union
 * assigns cleanly to a wider one and nothing failed when the two disagreed.
 */
export interface RuntimeReadiness {
  /** The runtime id, from the one declaration. */
  readonly id: AgentRuntimeId;
  /** Whether the runtime is configured/ready to run. Never carries a secret. */
  readonly ready: boolean;
}

/** The `GET /runtimes` response: per-runtime readiness, booleans only. */
export interface RuntimesReadinessResponse {
  readonly runtimes: readonly RuntimeReadiness[];
}

/**
 * Computes runtime readiness for `GET /runtimes` from the deployment auth sources
 * (3.3). It returns ONLY booleans:
 *   - `codex` is reported READY unconditionally — codex is the DEFAULT runtime and
 *     launches with or without a credential (its auth is resolved per task at
 *     provision time, owner-scoped), so the selector must never DISABLE codex; a
 *     missing codex credential is a per-task launch concern, not a readiness gate.
 *   - `claude-code` is READY iff a Claude OAuth token is configured, read through
 *     the {@link ClaudeAuthSource} port's `configured` boolean (Track 2). The port
 *     NEVER exposes the token itself on this path — only the boolean — so no secret
 *     can leak through the readiness surface.
 *
 * The Claude source is injected OPTIONALLY so a partial wiring (or a focused unit
 * context) degrades to `claude-code` NOT ready rather than throwing — fail closed
 * on the gate (an un-probeable Claude is treated as unconfigured, so the dialog
 * disables it) while keeping codex always offerable.
 */
@Injectable()
export class RuntimesService {
  private readonly logger = new Logger(RuntimesService.name);

  constructor(
    @Optional()
    @Inject(CLAUDE_AUTH_SOURCE)
    private readonly claudeAuthSource?: ClaudeAuthSource,
  ) {}

  /**
   * How each declared runtime decides it is ready.
   *
   * A total `Record` rather than a hand-written response list. The list version
   * was the quietest defect this endpoint could have: a newly declared and
   * registered runtime would be accepted by the API and resolved by the registry,
   * and then simply not appear here — so the console, which builds its selector
   * from this response, would never offer it, with nothing failing anywhere.
   */
  private readonly readinessPolicy: Readonly<
    Record<AgentRuntimeId, (ownerUserId: string | null) => Promise<boolean>>
  > = {
    // codex is the DEFAULT runtime and launches with or without a credential
    // (auth is resolved per task at provision time), so the selector must never
    // disable it; a missing codex credential is a launch concern, not a gate.
    codex: async () => true,
    'claude-code': (ownerUserId) => this.isClaudeConfigured(ownerUserId),
  };

  async getReadiness(ownerUserId: string | null): Promise<RuntimesReadinessResponse> {
    return {
      runtimes: await Promise.all(
        AGENT_RUNTIME_IDS.map(async (id) => ({
          id,
          ready: await this.readinessPolicy[id](ownerUserId),
        })),
      ),
    };
  }

  /**
   * Whether a Claude OAuth token is configured, via the {@link ClaudeAuthSource}
   * `configured` boolean (NEVER the token value). Fail-closed: a missing source or
   * a rejected probe reports NOT configured so the dialog disables claude-code
   * rather than offering a runtime that would fail at launch.
   */
  private async isClaudeConfigured(ownerUserId: string | null): Promise<boolean> {
    if (!this.claudeAuthSource || !ownerUserId) return false;
    try {
      return await this.claudeAuthSource.configured(ownerUserId);
    } catch (err) {
      this.logger.warn(
        `claude runtime readiness probe failed (reporting not ready): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }
}
