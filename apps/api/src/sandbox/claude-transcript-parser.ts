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
import type { SessionTurn, SessionHistoryMeta } from '@cap/contracts';
import type { ParsedRollout } from './rollout-parser';

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

/**
 * Parse a full Claude session JSONL document into the ordered render-contract.
 *
 * @param jsonl the raw `<session-id>.jsonl` text (one JSON object per line).
 */
export function parseClaudeTranscript(jsonl: string): ParsedRollout {
  const meta: Omit<SessionHistoryMeta, 'taskId'> = {};
  const turns: SessionTurn[] = [];

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

    const msg = line.message;
    if (line.type === 'user' && msg && msg.role === 'user') {
      const text = claudeContentText(msg.content).trim();
      // Skip a user record whose content is purely tool_result blocks (no text).
      if (text.length > 0) turns.push({ kind: 'user', text });
      continue;
    }
    if (line.type === 'assistant' && msg && msg.role === 'assistant') {
      if (!meta.model && typeof msg.model === 'string') meta.model = msg.model;
      const text = claudeContentText(msg.content).trim();
      if (text.length > 0) {
        turns.push({
          kind: 'assistant',
          text,
          isFinalAnswer: msg.stop_reason === 'end_turn',
        });
      }
      continue;
    }
    // All other record types are lifecycle/sidecar, not transcript turns — skipped.
  }

  return { turns, meta };
}
