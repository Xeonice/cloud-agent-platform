import type { TranscriptRecord } from './agent-runtime.port';

/**
 * Claude Code transcript helpers (add-claude-code-runtime, tasks 2.7/2.8) — pure,
 * dependency-free functions for locating and parsing the `--session-id` JSONL.
 * Split out from the runtime so the slug derivation and the end_turn detection are
 * unit-testable in isolation (the hard cases: last-assistant-is-not-last-line and
 * a mid-turn `tool_use` event).
 */

/**
 * Canonicalize a workspace path into Claude's project-directory SLUG.
 *
 * Claude stores each project's transcripts under
 * `~/.claude/projects/<slug>/<session-id>.jsonl`, where `<slug>` is the absolute
 * project path with every non-alphanumeric character (the leading slash, every
 * path separator, and any `.`/`_`) replaced by `-`. So `/home/gem/workspace`
 * becomes `-home-gem-workspace`. The path MUST be the CANONICALIZED workspace
 * path (the same absolute clone dir the launch line used as cwd), else the slug
 * misses and exit detection never resolves.
 */
export function claudeProjectSlug(workspaceDir: string): string {
  return workspaceDir.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Absolute path of a session's transcript JSONL inside the sandbox. */
export function claudeTranscriptPath(
  configDir: string,
  workspaceDir: string,
  sessionId: string,
): string {
  return `${configDir}/projects/${claudeProjectSlug(workspaceDir)}/${sessionId}.jsonl`;
}

/**
 * Parse a Claude transcript JSONL blob into structured records, ALL record types
 * (task 2.8): `assistant`/`user`/`system`/`attachment`/title/last-prompt and any
 * unknown type are kept (unknown ones degrade to `type:'unknown'`), so the parent
 * chain through `attachment`/`system` records is not broken for archival. A
 * malformed line is skipped, never aborting the parse — a best-effort read of a
 * frozen sandbox yields "what was parseable".
 */
export function parseClaudeTranscript(jsonl: string): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof obj !== 'object' || obj === null) continue;
    const raw = obj as Record<string, unknown>;
    const type = typeof raw['type'] === 'string' ? (raw['type'] as string) : 'unknown';
    const role = extractRole(raw);
    records.push(role === undefined ? { type, raw } : { type, role, raw });
  }
  return records;
}

/**
 * Whether a parsed transcript marks the turn complete: the LAST record of
 * `type === 'assistant'` carries `message.stop_reason === 'end_turn'` (task 2.7).
 *
 * DEMOTED (align-claude-runtime-resident-session): no longer wired into
 * `ClaudeCodeRuntime.detectExit` — claude is now a RESIDENT session resolved by
 * `tmux has-session` (codex parity), so a finished turn does NOT complete the task.
 * Retained as a tested pure helper (a turn-complete signal the retention/UX layers
 * MAY consume), NOT a task-termination trigger.
 *
 * It scans for the last ASSISTANT record, NOT the last line — `system`/`ai-title`/
 * `last-prompt` records trail the final assistant event, so reading the last line
 * would miss completion. A mid-turn assistant event (`stop_reason === 'tool_use'`)
 * is NOT complete. A clarifying-question ending is still `end_turn`, so it counts
 * as complete (one-shot semantics; the question is surfaced as the final output).
 */
export function isTurnComplete(records: readonly TranscriptRecord[]): boolean {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record.type !== 'assistant') continue;
    // Found the LAST assistant record. The verdict is THIS one's stop_reason —
    // we do not keep scanning earlier assistant events.
    return assistantStopReason(record.raw) === 'end_turn';
  }
  return false;
}

/** Extract a record's role from the common `role` / `message.role` shapes. */
function extractRole(raw: Record<string, unknown>): string | undefined {
  if (typeof raw['role'] === 'string') return raw['role'] as string;
  const message = raw['message'];
  if (
    typeof message === 'object' &&
    message !== null &&
    typeof (message as Record<string, unknown>)['role'] === 'string'
  ) {
    return (message as Record<string, unknown>)['role'] as string;
  }
  return undefined;
}

/**
 * The `stop_reason` of an assistant record. Claude nests the model response under
 * `message`, so the stop_reason lives at `message.stop_reason`; a top-level
 * `stop_reason` is tolerated as a fallback.
 */
function assistantStopReason(raw: Record<string, unknown>): string | undefined {
  const message = raw['message'];
  if (typeof message === 'object' && message !== null) {
    const nested = (message as Record<string, unknown>)['stop_reason'];
    if (typeof nested === 'string') return nested;
  }
  if (typeof raw['stop_reason'] === 'string') return raw['stop_reason'] as string;
  return undefined;
}
