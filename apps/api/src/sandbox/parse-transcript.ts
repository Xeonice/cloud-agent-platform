/**
 * Transcript parser dispatch (add-headless-execution-track). The single place that maps a
 * runtime's declared `transcriptFormat` to its parser, so every read surface (MCP
 * `get_transcript`, `/v1` transcript, session-history, durable capture) parses the right
 * format. The AgentRuntime port stays a leaf — it declares the format tag; THIS sandbox-layer
 * module owns the parsers and the dispatch.
 */
import type { TranscriptFormat } from '../agent-runtime/agent-runtime.port';
import { parseClaudeTranscript } from './claude-transcript-parser';
import { parseRollout, type ParsedRollout } from './rollout-parser';

/** Parse a raw transcript JSONL into the shared render-contract, keyed by the runtime format. */
export function parseTranscript(
  jsonl: string,
  format: TranscriptFormat,
): ParsedRollout {
  return format === 'claude-jsonl'
    ? parseClaudeTranscript(jsonl)
    : parseRollout(jsonl);
}
