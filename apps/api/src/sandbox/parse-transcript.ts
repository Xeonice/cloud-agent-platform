/**
 * Transcript parser dispatch (unify-transcript-parsers, D1+D2). The single place that
 * maps a runtime's declared `transcriptFormat` to its parser, so every read surface (MCP
 * `get_transcript`, `/v1` transcript, session-history, durable capture) parses the right
 * format. The AgentRuntime port stays a leaf — it declares the format tag; THIS sandbox-layer
 * module owns the parsers, the `TranscriptSource` union, and the registry dispatch.
 *
 * Adding a runtime is two ADDITIVE edits here: one `TranscriptSource` variant (in
 * `transcript-source.ts`) and one `REGISTRY` entry — no ternary/switch to extend.
 */
import type { TranscriptFormat } from '../agent-runtime/agent-runtime.port';
import { claudeTranscriptParser } from './claude-transcript-parser';
import { codexTranscriptParser, type ParsedRollout } from './rollout-parser';
import type { TranscriptParser, TranscriptSource } from './transcript-source';

export type { TranscriptSource, TranscriptParser, TranscriptSourceFor } from './transcript-source';

/**
 * The parser registry: exactly one {@link TranscriptParser} per {@link TranscriptFormat}.
 * The `Record` type makes the mapping total — adding a format literal to the union forces
 * a matching entry here at compile time, which is the point of D1 (registry over ternary).
 */
const REGISTRY: { [F in TranscriptFormat]: TranscriptParser<F> } = {
  'codex-rollout': codexTranscriptParser,
  'claude-jsonl': claudeTranscriptParser,
};

/**
 * Construct the JSONL-bearing {@link TranscriptSource} for a `format`. Today both
 * production formats are single-newest-JSONL, so the source is `{ format, jsonl }`;
 * a future non-single-file format builds its own variant on its own read path.
 */
function jsonlSource(jsonl: string, format: TranscriptFormat): TranscriptSource {
  return { format, jsonl };
}

/**
 * Parse a raw transcript JSONL into the shared render-contract, keyed by the runtime
 * format. The external `(jsonl, format)` signature is HELD STABLE for the four call
 * sites (MCP `get_transcript`, `/v1` transcript, console session-history, durable
 * capture/backfill): the JSONL-bearing source is built internally and dispatched via a
 * registry lookup, replacing the former format ternary.
 */
export function parseTranscript(
  jsonl: string,
  format: TranscriptFormat,
): ParsedRollout {
  const source = jsonlSource(jsonl, format);
  // The registry is total over `TranscriptFormat`; the source's `format` selects the
  // matching parser, and the source is statically the variant that parser narrows to.
  return (REGISTRY[format] as TranscriptParser).parse(source);
}
