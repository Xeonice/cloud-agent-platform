/**
 * Pure parser: codex 0.131 rollout JSONL → the `@cap/contracts` session-history
 * render-contract (session-sandbox-retention, Track 2 / design D3).
 *
 * The api reads `rollout-*.jsonl` out of a stopped, retained sandbox container
 * (never `history.jsonl` — that is only the global user-input log) and turns it
 * into typed `SessionTurn`s the web renders directly. No raw rollout ever leaves
 * the api.
 *
 * FORMAT (verified against 211 real codex 0.131 rollouts). Each line is
 * `{timestamp, type, payload}`. Two parallel streams coexist in one file:
 *   - `event_msg`     — codex's user-facing event stream. We DRIVE off this:
 *       · `user_message`  → `payload.message` is the operator's CLEAN text.
 *       · `agent_message` → `payload.message` + `payload.phase`
 *         (`'final_answer'` vs `'commentary'`) — codex's OWN final-answer marker,
 *         so `isFinalAnswer` is read off `phase`, never inferred from ordering.
 *       · `token_count`   → `payload.info.last_token_usage` (per-turn delta).
 *   - `response_item` — the raw model-API items. We use these ONLY for tools
 *       (`function_call`/`function_call_output` and `custom_tool_call`/output,
 *       linked by `call_id`); the `message`/`reasoning` items here are the
 *       wrapper-wrapped / encrypted DUPLICATES of the event_msg stream and are
 *       skipped to avoid double-rendering. If a rollout has NO `user_message`
 *       events (e.g. a non-interactive `codex exec` run) we fall back to
 *       `response_item message role=user`, stripping the known instruction
 *       wrapper so only the operator's text remains.
 *
 * Defensive by construction: unknown line types are skipped, missing fields
 * degrade to honest omissions, and a malformed line never aborts the parse — a
 * best-effort read of a frozen sandbox must yield "what was parseable".
 */
import type {
  SessionTurn,
  SessionHistoryMeta,
  ToolTurn,
} from '@cap/contracts';

/** The parsed transcript: ordered turns + the header metadata. */
export interface ParsedRollout {
  turns: SessionTurn[];
  meta: Omit<SessionHistoryMeta, 'taskId'>;
}

/** One decoded rollout line; everything past `type` is best-effort. */
interface RolloutLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown> & { type?: string };
}

/** Concatenate a codex `content: [{type, text}]` block into plain text. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : '',
    )
    .join('');
}

/**
 * Strip a known leading instruction wrapper off a fallback (`response_item`)
 * user prompt so only the operator's own text remains. CONSERVATIVE: it only
 * removes an unambiguous leading angle-bracket-tagged block (e.g.
 * `<permissions instructions>…</…>` / `<user_instructions>…</…>`) that codex's
 * harness prepends. Anything else passes through UNCHANGED — over-stripping a
 * free-form prompt that merely starts with a heading would lose real operator
 * text, which is worse than showing a short preamble. The `event_msg
 * user_message` path needs none of this (codex already separated the text).
 */
export function stripPromptWrapper(text: string): string {
  let out = text;
  // Peel leading fully-tagged instruction blocks: `<x instructions>…</x instructions>`.
  const tagged = /^\s*<([a-z][\w-]*(?:\s+instructions)?)>[\s\S]*?<\/\1>\s*/i;
  while (tagged.test(out)) {
    const next = out.replace(tagged, '');
    if (next === out) break;
    out = next;
  }
  return out.trim().length > 0 ? out.trim() : text.trim();
}

/** Parse a numeric per-turn token total out of a `token_count` info payload. */
function lastTurnTokens(info: unknown): number | undefined {
  if (!info || typeof info !== 'object') return undefined;
  const last = (info as { last_token_usage?: unknown }).last_token_usage;
  if (!last || typeof last !== 'object') return undefined;
  const total = (last as { total_tokens?: unknown }).total_tokens;
  return typeof total === 'number' && Number.isFinite(total) && total > 0
    ? total
    : undefined;
}

/**
 * Best-effort added/removed line count for an `apply_patch` turn (D4), counted
 * off the patch text already captured in the tool args. Lines added start with
 * `+` and removed with `-`, EXCLUDING the `+++`/`---` file headers. Returns
 * `undefined` when the text does not look like a patch or carries no +/- lines —
 * an honest omission, never a fabricated count.
 */
function patchDiffstat(args: string): { add: number; del: number } | undefined {
  if (!args.includes('*** Begin Patch') && !/^[+-]/m.test(args)) return undefined;
  let add = 0;
  let del = 0;
  for (const ln of args.split('\n')) {
    if (ln.startsWith('+++') || ln.startsWith('---')) continue;
    if (ln.startsWith('+')) add++;
    else if (ln.startsWith('-')) del++;
  }
  return add === 0 && del === 0 ? undefined : { add, del };
}

/**
 * The producing line's timestamp as a spreadable `{ at }` fragment (D2), or an
 * empty object when the line has none — so the turn omits `at` rather than
 * carrying `undefined`/a fabricated value.
 */
function atOf(line: RolloutLine): { at?: string } {
  return typeof line.timestamp === 'string' ? { at: line.timestamp } : {};
}

/**
 * Parse a full rollout JSONL document into the ordered render-contract.
 *
 * @param jsonl the raw `rollout-*.jsonl` text (one JSON object per line).
 */
export function parseRollout(jsonl: string): ParsedRollout {
  const lines: RolloutLine[] = [];
  for (const raw of jsonl.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed) as RolloutLine);
    } catch {
      // A torn final line (frozen-layer read) — skip it, keep the rest.
    }
  }

  const meta: Omit<SessionHistoryMeta, 'taskId'> = {};
  const turns: SessionTurn[] = [];
  // Tool turns indexed by call_id so a later `*_output` line attaches to its call.
  const toolByCallId = new Map<string, ToolTurn>();
  // The most recently appended tool turn, to carry an interleaved token_count.
  let lastToolTurn: ToolTurn | null = null;
  let sawUserMessageEvent = false;
  // Session totals (D5): accumulate token deltas; track the last seen line ts so
  // duration can be derived against `startedAt`. Both stay omitted when no data.
  let sessionTokens = 0;
  let sawTokens = false;
  let lastTimestamp: string | undefined;

  for (const line of lines) {
    const p = line.payload ?? {};
    const pType = p.type;
    // Track the most recent line timestamp for the session-duration total.
    if (typeof line.timestamp === 'string') lastTimestamp = line.timestamp;

    if (line.type === 'session_meta') {
      if (typeof p.cwd === 'string') meta.cwd = p.cwd;
      const ts = (p as { timestamp?: unknown }).timestamp ?? line.timestamp;
      if (typeof ts === 'string') meta.startedAt = ts;
      continue;
    }

    if (line.type === 'turn_context') {
      // The model label lives on turn_context (session_meta has no `model`).
      if (!meta.model && typeof (p as { model?: unknown }).model === 'string') {
        meta.model = (p as { model: string }).model;
      }
      continue;
    }

    if (line.type === 'event_msg') {
      if (pType === 'user_message') {
        sawUserMessageEvent = true;
        const message = (p as { message?: unknown }).message;
        if (typeof message === 'string' && message.length > 0) {
          turns.push({ kind: 'user', text: message, ...atOf(line) });
          lastToolTurn = null;
        }
        continue;
      }
      if (pType === 'agent_message') {
        const message = (p as { message?: unknown }).message;
        const phase = (p as { phase?: unknown }).phase;
        if (typeof message === 'string' && message.length > 0) {
          turns.push({
            kind: 'assistant',
            text: message,
            isFinalAnswer: phase === 'final_answer',
            ...atOf(line),
          });
          lastToolTurn = null;
        }
        continue;
      }
      if (pType === 'token_count') {
        const tokens = lastTurnTokens((p as { info?: unknown }).info);
        if (tokens !== undefined) {
          sessionTokens += tokens;
          sawTokens = true;
          if (lastToolTurn && lastToolTurn.tokenCount === undefined) {
            lastToolTurn.tokenCount = tokens;
          }
        }
        continue;
      }
      // Other event_msg kinds (task_started/complete, patch_apply_end, …) are
      // lifecycle signals, not transcript turns.
      continue;
    }

    if (line.type === 'response_item') {
      if (pType === 'function_call' || pType === 'custom_tool_call') {
        const callId = (p as { call_id?: unknown }).call_id;
        const name = (p as { name?: unknown }).name;
        // `function_call` carries `arguments` (JSON string); `custom_tool_call`
        // carries `input`. Either way render the raw command monospace.
        const argsRaw =
          (p as { arguments?: unknown }).arguments ?? (p as { input?: unknown }).input;
        const toolName = typeof name === 'string' ? name : 'tool';
        const toolArgs = typeof argsRaw === 'string' ? argsRaw : safeStringify(argsRaw);
        const turn: ToolTurn = {
          kind: 'tool',
          name: toolName,
          args: toolArgs,
          output: null,
          // diffstat only for apply_patch turns; absent otherwise / on unparseable patch.
          ...(toolName === 'apply_patch'
            ? (() => {
                const diffstat = patchDiffstat(toolArgs);
                return diffstat ? { diffstat } : {};
              })()
            : {}),
          ...atOf(line),
        };
        turns.push(turn);
        lastToolTurn = turn;
        if (typeof callId === 'string') toolByCallId.set(callId, turn);
        continue;
      }
      if (pType === 'function_call_output' || pType === 'custom_tool_call_output') {
        const callId = (p as { call_id?: unknown }).call_id;
        const output = (p as { output?: unknown }).output;
        const text = typeof output === 'string' ? output : safeStringify(output);
        const turn = typeof callId === 'string' ? toolByCallId.get(callId) : undefined;
        if (turn) turn.output = text;
        continue;
      }
      // `message` (any role) + `reasoning` response_items are the wrapped /
      // encrypted duplicates of the event_msg stream — skip, UNLESS this rollout
      // surfaced no user_message events at all (codex exec): then recover the
      // user prompt from role=user, wrapper-stripped.
      if (pType === 'message' && (p as { role?: unknown }).role === 'user') {
        if (!sawUserMessageEvent) {
          const text = stripPromptWrapper(contentText((p as { content?: unknown }).content));
          if (text.length > 0) {
            turns.push({ kind: 'user', text, ...atOf(line) });
            lastToolTurn = null;
          }
        }
        continue;
      }
      continue;
    }
  }

  // Session totals (D5): omit each unless its source data is present — never
  // report zero or a fabricated value.
  if (sawTokens && sessionTokens > 0) meta.totalTokens = sessionTokens;
  if (meta.startedAt && lastTimestamp) {
    const ms = Date.parse(lastTimestamp) - Date.parse(meta.startedAt);
    if (Number.isFinite(ms) && ms >= 0) meta.durationMs = ms;
  }

  return { turns, meta };
}

/** JSON.stringify that never throws (circular/odd values → a readable label). */
function safeStringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
