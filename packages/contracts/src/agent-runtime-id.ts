/**
 * THE declaration of which agent runtimes exist.
 *
 * This list was previously restated independently in four places, and nothing
 * compared them: the schema in `task.ts`, a hand-written union in the api's
 * `agent-runtime.port.ts`, the api's actual registry registrations, and a fourth
 * union in the console — which re-declared the set despite already depending on
 * this package. The registry's own docstring claimed "registering a third runtime
 * needs no edit here" while narrowing to the hand-written union three lines below
 * it, and the schema here carried a comment promising to stay "byte-for-byte in
 * sync" with the registry. Both promises were prose. Adding a runtime meant
 * finding all four, with nothing pointing at them and nothing failing if one was
 * missed.
 *
 * Everything that depends on which runtimes exist derives from here. A surface
 * that legitimately admits MORE, or covers only a SUBSET, states that as an
 * explicit extension of — or subset of — this list, so the widening or narrowing
 * is visible rather than hidden in a separately maintained array.
 *
 * This mirrors {@link SANDBOX_PROVIDER_FAMILIES} deliberately: the two axes had
 * the same defect, and only the provider one had been fixed, which is why only
 * the provider axis could admit a third implementation.
 */
export const AGENT_RUNTIME_IDS = ['claude-code', 'codex'] as const;

export type AgentRuntimeId = (typeof AGENT_RUNTIME_IDS)[number];

/**
 * The runtime applied when a create request omits `runtime` and when an existing
 * persisted task carries no `runtime` value (additive-nullable column). Existing
 * tasks and omitted requests therefore read back as `codex`.
 *
 * Declared here rather than beside the schema so that the api's own default and
 * this one cannot be two independent literals asserted against two independent
 * copies of the union.
 */
export const DEFAULT_AGENT_RUNTIME_ID = 'codex' as const satisfies AgentRuntimeId;

/**
 * ONE credential-mode vocabulary for every runtime (unlock-extension-axes D2).
 *
 * Previously two unrelated per-runtime mode types existed (`CodexCredentialMode`
 * = 'official' | 'compatible', `ClaudeCredentialMode` = 'subscription' |
 * 'api_key' in settings.ts) and the settings surface hard-wired one prop +
 * handler pair per runtime around them. Decision (task 1.4): a UNIFIED mode
 * vocabulary here, with each {@link RUNTIME_METADATA} row narrowing to its own
 * literal subset tuple — that per-row narrowing IS the discriminated view, so a
 * third runtime adds its modes to this list plus its row instead of minting a
 * third unrelated type. The settings.ts wire schemas remain literal subsets of
 * this vocabulary (their convergence is a consumer-side change, not a wire
 * change).
 */
export const RUNTIME_CREDENTIAL_MODES = [
  'official',
  'compatible',
  'subscription',
  'api_key',
] as const;

export type RuntimeCredentialMode = (typeof RUNTIME_CREDENTIAL_MODES)[number];

/**
 * The per-runtime display/policy metadata row backing every console and api
 * surface that previously branched on runtime identity.
 *
 * Field-set decision (task 1.4), from a diff against competitor
 * executor-profiles (Vibe Kanban: display label, launch-command preview, model
 * variants, per-agent MCP config):
 * - label / hint / cliPreviewComment / credential copy — adopted; they replace
 *   the web-local `RUNTIME_COPY` table, the create-dialog CLI-preview ternary,
 *   and the hardcoded credential-alert branches.
 * - variant/model axis — deliberately EXCLUDED: the model axis is already owned
 *   by the live per-owner runtime-model catalog (runtime-model.ts); a static
 *   metadata field would be a second declaration of a live axis. No optional
 *   placeholder is reserved — the table is additive, so a future field lands
 *   together with its first consumer instead of as a dead slot.
 * - per-runtime MCP config — no such axis exists on this platform; excluded.
 */
export interface RuntimeMetadata {
  /** Display label (e.g. task lists, failure summaries, selector options). */
  readonly label: string;
  /** Selector option hint (create-task dialog). */
  readonly hint: string;
  /** Leading comment line of the create-task dialog's CLI command preview. */
  readonly cliPreviewComment: string;
  /** Copy for the runtime credential-failure alert (no consumer branches). */
  readonly credential: {
    readonly expiredTitle: string;
    readonly rejectedTitle: string;
    readonly description: string;
    readonly actionLabel: string;
  };
  /** The credential modes this runtime's settings surface offers. */
  readonly credentialModes: readonly RuntimeCredentialMode[];
}

/**
 * THE compile-time-total per-runtime metadata table (unlock-extension-axes D2).
 *
 * `as const satisfies Record<AgentRuntimeId, RuntimeMetadata>` makes adding a
 * runtime id without adding its row an ordinary typecheck failure naming the
 * missing key, while consumers keep the literal row types. Totality is guarded
 * by the self-invalidating fixture in `runtime-metadata.typecheck.ts` (same
 * shape as the api's `agent-runtime-registration.typecheck.ts`). Consumers look
 * rows up by id; none may branch on runtime identity for display copy.
 */
export const RUNTIME_METADATA = {
  codex: {
    label: 'Codex',
    hint: 'OpenAI Codex CLI（默认）',
    cliPreviewComment: '# 沙箱内启动 codex',
    credential: {
      expiredTitle: 'Codex 登录已过期',
      rejectedTitle: 'Codex 登录凭据已失效',
      description:
        '可重新连接 Codex 官方账号或更新兼容提供方凭据；本次任务不会自动重试。',
      actionLabel: '更新 Codex 凭据',
    },
    credentialModes: ['official', 'compatible'],
  },
  'claude-code': {
    label: 'Claude Code',
    hint: 'Anthropic Claude Code CLI',
    cliPreviewComment: '# 沙箱内启动 claude',
    credential: {
      expiredTitle: 'Claude Code 凭据已过期',
      rejectedTitle: 'Claude Code 凭据已失效',
      description:
        '可更新订阅 setup-token 或 Anthropic API Key；本次任务不会自动重试。',
      actionLabel: '更新 Claude Code 凭据',
    },
    credentialModes: ['subscription', 'api_key'],
  },
} as const satisfies Record<AgentRuntimeId, RuntimeMetadata>;

/**
 * HOW a runtime's transcript source is read out of the retained container: a
 * vocabulary of source-read SHAPES, named by shape rather than by runtime,
 * because a reader implements a shape (a third runtime reusing the JSONL shape
 * must not force a fake member).
 *
 * - `single-newest-jsonl` — read the lexicographically-newest file matching the
 *   runtime's transcript artifact glob and hand the parser one JSONL document
 *   (codex and claude-code today).
 * - `per-message-json-dir` — a session directory of per-message JSON files
 *   (the shape opencode persists: session/message/part records, not one JSONL).
 *
 * RULING RECORD (unlock-extension-axes D3): 2026-07-28
 * fail-loud-on-unknown-runtime judged this seam a "false seam — either real
 * dispatch or delete the promise" and, with no second shape in evidence, chose
 * a single member with a loud throw. This declaration explicitly SUPERSEDES
 * that ruling because its triggering condition changed: opencode's per-message
 * JSON store is a demonstrated second shape. The second member exists at
 * compile time with NO registered runtime declaring it; the sandbox facade's
 * read seam dispatches over this vocabulary and still fails loudly, naming the
 * strategy, for any value outside it.
 */
export const TRANSCRIPT_READ_STRATEGY_KINDS = [
  'single-newest-jsonl',
  'per-message-json-dir',
] as const;

export type TranscriptReadStrategyKind =
  (typeof TRANSCRIPT_READ_STRATEGY_KINDS)[number];

/**
 * The strategy value a runtime declares. Kept an object keyed by `kind` (not a
 * bare string) so a future shape can carry shape-specific configuration
 * additively without re-typing every declaration site.
 */
export interface TranscriptReadStrategy {
  readonly kind: TranscriptReadStrategyKind;
}
