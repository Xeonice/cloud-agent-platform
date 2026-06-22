/**
 * Pure parser: Claude Code session JSONL → the `@cap/contracts` session-history
 * render-contract (add-headless-execution-track). The claude sibling of
 * {@link parseRollout}; the sandbox transcript-read layer dispatches to it by the
 * runtime's declared `transcriptFormat === 'claude-jsonl'`, so the AgentRuntime port
 * stays a dependency-light leaf that never imports a parser.
 *
 * FORMAT (verified against real 2.1.183 sessions in the headless-execution spike).
 * `~/.claude/projects/<slug>/<session-id>.jsonl` is a CHAINED record stream — each line
 * `{type, uuid, parentUuid, sessionId, cwd, timestamp, message}`. Two record types carry
 * the conversation:
 *   - `type === 'user'`      → `message.content` is the operator text (string) — OR an
 *     array of `tool_result` blocks (no text), which is skipped.
 *   - `type === 'assistant'` → `message.content` is an array of blocks; the `text` blocks
 *     concatenate to the answer, and `message.stop_reason === 'end_turn'` marks the final
 *     answer. `message.model` carries the model label.
 * Every other type (`queue-operation`/`attachment`/`last-prompt`/`rate_limit_event`/
 * `system`/`summary`/…) is a lifecycle/sidecar record, NOT a transcript turn, and is skipped.
 *
 * Defensive by construction: a torn final line (frozen-layer read) or an unknown type never
 * aborts the parse — a best-effort read of a frozen sandbox yields "what was parseable".
 */
import type { SessionTurn, SessionHistoryMeta, ToolTurn } from '@cap/contracts';
import type { ParsedRollout } from './rollout-parser';
import { CallPairing } from './transcript-call-pairing';
import type { TranscriptParser, TranscriptSourceFor } from './transcript-source';

/** One decoded claude transcript line; everything past `type` is best-effort. */
interface ClaudeLine {
  type?: string;
  cwd?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    stop_reason?: string | null;
    model?: string;
  };
}

/** Marker used when a frozen-sandbox tool_result is externalized / missing / unreadable. */
const OUTPUT_UNAVAILABLE = '[output unavailable]';

/**
 * Per-tool field map (D5): each claude tool whose `input` carries a single
 * human-readable argument is rendered from THAT field (e.g. `Bash.command`),
 * so the tool card shows the command rather than the raw JSON blob. A tool not
 * in this map — or whose mapped field is absent / the wrong type — falls back to
 * a stable serialization of the whole `input` (see {@link toolArgsFor}).
 */
const TOOL_ARG_FIELD: Record<string, string> = {
  Bash: 'command',
  Grep: 'pattern',
  Read: 'file_path',
  Edit: 'file_path',
  Write: 'file_path',
};

/** JSON.stringify that never throws (circular/odd values → a readable label). */
function safeStringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Normalize a `tool_use` block's `input` to an object. Modern claude (≥ 2.1.92)
 * carries `input` as a parsed object; older sessions persist it as a JSON STRING
 * — parse those so the per-tool field map can still find its field. A non-JSON
 * string or any other shape yields `undefined` (the caller falls back to a stable
 * serialization of the original value).
 */
function normalizeToolInput(input: unknown): Record<string, unknown> | undefined {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON — fall through to undefined so the caller serializes the raw value.
    }
  }
  return undefined;
}

/**
 * Extract the human-readable `args` string for a `tool_use` block: the per-tool
 * mapped field when present and a string, else a stable serialization of the raw
 * `input` (object → JSON; pre-v2.1.92 JSON-string input → the string verbatim).
 */
function toolArgsFor(name: string, rawInput: unknown): string {
  const obj = normalizeToolInput(rawInput);
  const field = TOOL_ARG_FIELD[name];
  if (obj && field) {
    const value = obj[field];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  // Fallback: serialize the input as-is. A pre-v2.1.92 JSON string is passed
  // through verbatim; an object is stringified; anything else degrades readably.
  if (typeof rawInput === 'string') return rawInput;
  return safeStringify(rawInput);
}

/**
 * Decode a claude `tool_result` block's `content` (string OR `[{type:'text',
 * text}, …]`) into the paired tool output. A frozen-sandbox result that was
 * externalized / is missing / is unreadable degrades to {@link OUTPUT_UNAVAILABLE}
 * rather than aborting the parse (D5).
 */
function toolResultOutput(block: Record<string, unknown>): string {
  const content = block.content;
  if (typeof content === 'string') {
    return content.length > 0 ? content : OUTPUT_UNAVAILABLE;
  }
  if (Array.isArray(content)) {
    const text = content
      .map((b) =>
        b &&
        typeof b === 'object' &&
        (b as { type?: unknown }).type === 'text' &&
        typeof (b as { text?: unknown }).text === 'string'
          ? (b as { text: string }).text
          : '',
      )
      .join('');
    return text.length > 0 ? text : OUTPUT_UNAVAILABLE;
  }
  // No readable content at all (externalized / missing / odd shape) — degrade.
  return OUTPUT_UNAVAILABLE;
}

/** Concatenate a claude `content` (string OR `[{type:'text',text}, …]`) into plain text. */
function claudeContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : '',
    )
    .join('');
}

/** Extract `thinking` text from a `thinking` content block (best-effort). */
function thinkingText(block: Record<string, unknown>): string {
  const thinking = block.thinking;
  return typeof thinking === 'string' ? thinking : '';
}

/**
 * Parse a full Claude session JSONL document into the ordered render-contract.
 *
 * @param jsonl the raw `<session-id>.jsonl` text (one JSON object per line).
 */
export function parseClaudeTranscript(jsonl: string): ParsedRollout {
  const meta: Omit<SessionHistoryMeta, 'taskId'> = {};
  const turns: SessionTurn[] = [];
  // Tool turns paired by `tool_use_id` so a later `tool_result` block (in a
  // SUBSEQUENT `type:'user'` entry) attaches to its call — the shared
  // cross-runtime call-pairing primitive (claude's id field is `tool_use_id`).
  // An unmatched call keeps `output: null`; an orphan result is ignored.
  const toolByUseId = new CallPairing<ToolTurn>();
  // Track the last seen line timestamp for the session-duration total — mirrors
  // rollout-parser. NO token total: the claude session JSONL carries no clean
  // per-turn token delta (the `usage` block double-counts context), so
  // `totalTokens` is honestly OMITTED for this runtime rather than fabricated.
  let lastTimestamp: string | undefined;

  for (const raw of jsonl.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let line: ClaudeLine;
    try {
      line = JSON.parse(trimmed) as ClaudeLine;
    } catch {
      // A torn final line (frozen-layer read) — skip it, keep the rest.
      continue;
    }

    // The first seen cwd/timestamp populate the header metadata.
    if (!meta.cwd && typeof line.cwd === 'string') meta.cwd = line.cwd;
    if (!meta.startedAt && typeof line.timestamp === 'string') {
      meta.startedAt = line.timestamp;
    }
    if (typeof line.timestamp === 'string') lastTimestamp = line.timestamp;
    // The producing line's timestamp as a spreadable `{ at }` fragment (D2), or
    // an empty object when the line has none — so the turn omits `at`.
    const at: { at?: string } =
      typeof line.timestamp === 'string' ? { at: line.timestamp } : {};

    const msg = line.message;
    if (line.type === 'user' && msg && msg.role === 'user') {
      // A user entry's content can interleave operator text with `tool_result`
      // blocks that pair to earlier `tool_use` calls. Attach each result to its
      // buffered call (consuming tool_result-only entries WITHOUT a user turn),
      // and emit a user turn ONLY for the operator text that remains.
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (
            block &&
            typeof block === 'object' &&
            (block as { type?: unknown }).type === 'tool_result'
          ) {
            const b = block as Record<string, unknown>;
            toolByUseId.attachOutput(b.tool_use_id, toolResultOutput(b));
          }
        }
      }
      const text = claudeContentText(msg.content).trim();
      // Skip a user record whose content is purely tool_result blocks (no text).
      if (text.length > 0) turns.push({ kind: 'user', text, ...at });
      continue;
    }
    if (line.type === 'assistant' && msg && msg.role === 'assistant') {
      if (!meta.model && typeof msg.model === 'string') meta.model = msg.model;
      // The assistant content array interleaves `text`, `thinking`, and
      // `tool_use` blocks. Emit each in order: thinking → reasoning turn
      // (isFinalAnswer:false), tool_use → tool turn (paired by id), and the
      // concatenated `text` → one assistant turn (final-answer flag from
      // stop_reason). A string content has neither thinking nor tools.
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b.type === 'thinking') {
            const text = thinkingText(b).trim();
            // Reasoning maps to the existing 「推理」 channel (D6): an assistant
            // turn with isFinalAnswer:false, distinct from the final answer.
            if (text.length > 0) {
              turns.push({ kind: 'assistant', text, isFinalAnswer: false, ...at });
            }
          } else if (b.type === 'tool_use') {
            const name = typeof b.name === 'string' ? b.name : 'tool';
            const turn: ToolTurn = {
              kind: 'tool',
              name,
              args: toolArgsFor(name, b.input),
              output: null,
              ...at,
            };
            turns.push(turn);
            toolByUseId.registerCall(b.id, turn);
          }
        }
      }
      const text = claudeContentText(msg.content).trim();
      if (text.length > 0) {
        turns.push({
          kind: 'assistant',
          text,
          isFinalAnswer: msg.stop_reason === 'end_turn',
          ...at,
        });
      }
      continue;
    }
    // All other record types are lifecycle/sidecar, not transcript turns — skipped.
  }

  // Session duration (D5): last line ts − startedAt, omitted when unresolvable.
  if (meta.startedAt && lastTimestamp) {
    const ms = Date.parse(lastTimestamp) - Date.parse(meta.startedAt);
    if (Number.isFinite(ms) && ms >= 0) meta.durationMs = ms;
  }

  return { turns, meta };
}

/**
 * The claude parser as a {@link TranscriptParser} port object (unify-transcript-parsers,
 * D1+D2). It reads `source.jsonl` of its own narrowed `'claude-jsonl'` variant and
 * delegates to {@link parseClaudeTranscript} — extraction behavior is unchanged; this
 * only adapts the entry point to the source-bearing port the registry dispatches through.
 */
export const claudeTranscriptParser: TranscriptParser<'claude-jsonl'> = {
  format: 'claude-jsonl',
  parse(source: TranscriptSourceFor<'claude-jsonl'>): ParsedRollout {
    return parseClaudeTranscript(source.jsonl);
  },
};
