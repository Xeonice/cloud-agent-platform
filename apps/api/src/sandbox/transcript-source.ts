/**
 * The `TranscriptSource` discriminated union and the `TranscriptParser` port
 * (unify-transcript-parsers, Track 2 / design D1+D2). This is the seam that lets
 * a runtime feed a parser something other than "one JSONL string": the union is
 * tagged by `format`, and a future multi-record runtime (e.g. opencode) drops in
 * additively as a new variant + a new registry entry, without forcing the
 * existing JSONL-bearing parsers to pretend their input is a single file.
 *
 * Kept a dependency-light LEAF: it imports ONLY the `TranscriptFormat` literal
 * (type-only, so it elides at emit) and `ParsedRollout` (the shared render
 * contract). It never imports a concrete parser, so a parser `.ts` can type-import
 * the port from here without dragging the dispatcher's runtime graph into the
 * standalone parser compile.
 */
import type { TranscriptFormat } from '../agent-runtime/agent-runtime.port';
import type { ParsedRollout } from './rollout-parser';

/**
 * What a parser is handed to deserialize, discriminated by `format`. Today both
 * production runtimes persist a single newest JSONL file, so both variants carry
 * a `jsonl` string; the union is shaped so a `{ format: 'opencode-parts'; … }`
 * variant carrying structured records can be ADDED without touching the existing
 * members — the pivot of design D2.
 */
export type TranscriptSource =
  | { readonly format: 'codex-rollout'; readonly jsonl: string }
  | { readonly format: 'claude-jsonl'; readonly jsonl: string };

/** Narrow a `TranscriptSource` to the variant a given `format` literal selects. */
export type TranscriptSourceFor<F extends TranscriptFormat> = Extract<
  TranscriptSource,
  { format: F }
>;

/**
 * The parser port: one parser per `TranscriptFormat`. `parse` receives the
 * already-read `TranscriptSource` (its own narrowed variant) and returns the
 * shared `ParsedRollout` render-contract. The port owns NO read I/O — the read
 * layer hands it a fully-materialized source.
 */
export interface TranscriptParser<F extends TranscriptFormat = TranscriptFormat> {
  /** The format literal this parser is registered under. */
  readonly format: F;
  /** Deserialize the source of this parser's own format into render-contract turns. */
  parse(source: TranscriptSourceFor<F>): ParsedRollout;
}
