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
import { CallPairing } from './transcript-call-pairing';
import type { TranscriptParser, TranscriptSourceFor } from './transcript-source';

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

/**
 * Extract a HUMAN-READABLE command from a codex tool call (unify-transcript-parsers,
 * D4). Dispatch is on the TOOL NAME, before any field is read, because codex tool
 * shapes genuinely differ:
 *   - `exec_command`                       → `arguments.cmd` (a single command string)
 *   - `shell`/`local_shell`/`container.exec` → `arguments.command` (an argv array,
 *     joined by single spaces) — `workdir`/`timeout_ms` siblings are DROPPED so the
 *     rendered command is just the command, not the JSON envelope.
 *   - `apply_patch`                        → keeps its RAW `input` patch text verbatim
 *     (so `patchDiffstat` still counts off it).
 *   - anything else / wrong-typed field    → falls back to the raw arguments string.
 *
 * `rawArgs` is the raw `arguments`(JSON string)/`input` already resolved by the caller;
 * it is the conservative fallback whenever the expected field is absent or the wrong
 * type (an honest passthrough beats fabricating a command).
 */
function extractCommand(toolName: string, rawArgs: string): string {
  if (toolName === 'apply_patch') return rawArgs;

  // `arguments` is a JSON string on `function_call`; parse it to read the per-tool
  // field. A non-object / unparseable envelope degrades to the raw string.
  let parsed: Record<string, unknown> | undefined;
  try {
    const obj = JSON.parse(rawArgs);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      parsed = obj as Record<string, unknown>;
    }
  } catch {
    // Not a JSON object envelope — fall through to the raw-string fallback.
  }
  if (!parsed) return rawArgs;

  if (toolName === 'exec_command') {
    const cmd = parsed.cmd;
    return typeof cmd === 'string' ? cmd : rawArgs;
  }
  if (toolName === 'shell' || toolName === 'local_shell' || toolName === 'container.exec') {
    const command = parsed.command;
    if (Array.isArray(command) && command.every((c) => typeof c === 'string')) {
      // `workdir`/`timeout_ms` are intentionally NOT included — the command alone.
      return (command as string[]).join(' ');
    }
    return rawArgs;
  }
  // Unknown tool: render the raw arguments string (no fabricated extraction).
  return rawArgs;
}

/**
 * Conservatively strip the codex exec OUTPUT wrapper (unify-transcript-parsers, D4).
 * codex wraps exec output in a metadata envelope whose grammar drifts across versions,
 * e.g.:
 *   Exit code: 0
 *   Wall time: 1.2s
 *   Total output lines: 5
 *   Output:
 *   <the real body>
 *   (3 lines omitted)
 * We keep ONLY the body after the `Output:\n` cut point, and drop a trailing
 * `(N lines omitted)` marker. The strip is GATED: it only fires when the text actually
 * begins with one of the recognized header prefixes AND carries the `Output:` cut —
 * any format mismatch (a drifted/absent wrapper) PASSES THROUGH unchanged, and a strip
 * that would empty a body-carrying output is rejected (we return the original). This
 * trades "never corrupt real output" for "occasionally show a wrapper", deliberately.
 */
function stripExecOutputWrapper(output: string): string {
  // Recognize the wrapper only by its documented leading metadata prefixes.
  const HEADER = /^(Exit code:|Wall time:|Total output lines:)/;
  if (!HEADER.test(output)) return output;
  const cut = output.indexOf('Output:\n');
  if (cut === -1) return output; // header present but no body cut point → passthrough.
  let body = output.slice(cut + 'Output:\n'.length);
  // Drop a trailing `(N lines omitted)` truncation marker (codex appends it when it
  // elides middle/tail lines). Only an exact trailing marker line is removed.
  body = body.replace(/\n?\(\d+ lines omitted\)\s*$/, '');
  // Never empty a body-carrying output: if stripping left nothing but the original
  // had content, the wrapper shape was not what we assumed — pass through untouched.
  if (body.trim().length === 0 && output.trim().length > 0) return output;
  return body;
}

/**
 * Filter codex `<environment_context>` / `<system-reminder>` wrappers off an
 * `event_msg user_message` payload (unify-transcript-parsers, D4). codex injects
 * these synthetic blocks INTO the user-facing user_message stream; they are harness
 * context, not operator text, and `stripPromptWrapper`'s `<x instructions>` regex
 * does NOT match them. Behavior:
 *   - a payload that is PURELY one or more such wrapper blocks → returns `''`
 *     (the caller emits no user turn);
 *   - a wrapper block followed by real operator text → returns ONLY the operator text;
 *   - anything with no wrapper → passes through unchanged.
 * Only fully-tagged `<tag>…</tag>` blocks for these two tags are removed; a stray
 * mention of the tag name in free text is untouched.
 */
function stripEnvironmentWrapper(text: string): string {
  const block = /<(environment_context|system-reminder)>[\s\S]*?<\/\1>/gi;
  const stripped = text.replace(block, '').trim();
  return stripped;
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
  // Tool turns paired by `call_id` so a later `*_output` line attaches to its
  // call (the shared cross-runtime call-pairing primitive; codex's id field is
  // `call_id`). An unmatched call keeps `output: null`; an orphan output is
  // ignored without throwing.
  const toolByCallId = new CallPairing<ToolTurn>();
  // The most recently appended tool turn, to carry an interleaved token_count.
  let lastToolTurn: ToolTurn | null = null;
  let sawUserMessageEvent = false;
  // Append a user turn, DEDUPing an ADJACENT identical one (D4). codex double-writes
  // the same operator prompt across the event_msg and response_item streams; when the
  // most recent turn is an identical user turn we drop the duplicate. Non-adjacent
  // identical user turns (the operator genuinely repeating themselves) are preserved.
  const pushUser = (text: string, line: RolloutLine): void => {
    const prev = turns[turns.length - 1];
    if (prev && prev.kind === 'user' && prev.text === text) return;
    turns.push({ kind: 'user', text, ...atOf(line) });
    lastToolTurn = null;
  };
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
          // Filter `<environment_context>` / `<system-reminder>` wrappers (D4): a
          // pure-wrapper payload yields '' (no turn); a wrapped operator message
          // degrades to only the operator text.
          const text = stripEnvironmentWrapper(message);
          if (text.length > 0) pushUser(text, line);
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
        // carries `input`. The raw envelope is resolved here; `extractCommand` below
        // turns it into the human-readable command per tool name (D4).
        const argsRaw =
          (p as { arguments?: unknown }).arguments ?? (p as { input?: unknown }).input;
        const toolName = typeof name === 'string' ? name : 'tool';
        const rawArgs = typeof argsRaw === 'string' ? argsRaw : safeStringify(argsRaw);
        // Render a HUMAN-READABLE command per tool (D4) instead of the raw JSON envelope;
        // apply_patch keeps its raw `input` so the diffstat below still counts off it.
        const toolArgs = extractCommand(toolName, rawArgs);
        const turn: ToolTurn = {
          kind: 'tool',
          name: toolName,
          args: toolArgs,
          output: null,
          // diffstat only for apply_patch turns; absent otherwise / on unparseable patch.
          // apply_patch's `toolArgs` is its raw patch text, so this is unchanged.
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
        toolByCallId.registerCall(callId, turn);
        continue;
      }
      if (pType === 'function_call_output' || pType === 'custom_tool_call_output') {
        const callId = (p as { call_id?: unknown }).call_id;
        const output = (p as { output?: unknown }).output;
        const rawText = typeof output === 'string' ? output : safeStringify(output);
        // Strip the codex exec output wrapper conservatively (D4): only when the
        // documented header grammar is present; passthrough on any mismatch.
        const text = stripExecOutputWrapper(rawText);
        toolByCallId.attachOutput(callId, text);
        continue;
      }
      // `message` (any role) + `reasoning` response_items are the wrapped /
      // encrypted duplicates of the event_msg stream — skip, UNLESS this rollout
      // surfaced no user_message events at all (codex exec): then recover the
      // user prompt from role=user, wrapper-stripped.
      if (pType === 'message' && (p as { role?: unknown }).role === 'user') {
        if (!sawUserMessageEvent) {
          const text = stripPromptWrapper(contentText((p as { content?: unknown }).content));
          // Route through pushUser so an adjacent identical user turn (the event_msg
          // vs response_item double-write) is deduped (D4).
          if (text.length > 0) pushUser(text, line);
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

/**
 * The codex parser as a {@link TranscriptParser} port object (unify-transcript-parsers,
 * D1+D2). It reads `source.jsonl` of its own narrowed `'codex-rollout'` variant and
 * delegates to {@link parseRollout} — extraction behavior is unchanged; this only
 * adapts the entry point to the source-bearing port the registry dispatches through.
 */
export const codexTranscriptParser: TranscriptParser<'codex-rollout'> = {
  format: 'codex-rollout',
  parse(source: TranscriptSourceFor<'codex-rollout'>): ParsedRollout {
    return parseRollout(source.jsonl);
  },
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
