import { z } from 'zod';

/**
 * asciicast v2 shapes for terminal replay (session-terminal-replay).
 *
 * Verified against docs.asciinema.org/manual/asciicast/v2/: an asciicast file is
 * newline-delimited JSON — the FIRST line is a header object, each later line is
 * an event tuple `[time, code, data]`. `time` is cumulative seconds since the
 * recording started; `o`=stdout output, `i`=input, `r`=resize (data `"COLSxROWS"`),
 * `m`=marker; `data` is a valid-UTF-8 JSON-escaped string (NOT base64).
 *
 * Single source of truth shared by the api (writer + read endpoint) and the web
 * timing-player. We pin v2 (widest compatibility).
 */

/** asciicast format version this codebase records/reads. */
export const ASCIICAST_VERSION = 2;

/**
 * asciicast v2 header — the file's first line. `width`/`height` carry the
 * recording geometry (the player sizes the terminal from these); `timestamp`
 * is epoch seconds; `env` is optional metadata (e.g. `TERM`).
 */
export const AsciicastHeaderSchema = z.object({
  version: z.literal(2),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  timestamp: z.number().int().nonnegative().optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type AsciicastHeader = z.infer<typeof AsciicastHeaderSchema>;

/** asciicast event codes (output / input / resize / marker). */
export const ASCIICAST_EVENT_CODES = ['o', 'i', 'r', 'm'] as const;
export const AsciicastEventCodeSchema = z.enum(ASCIICAST_EVENT_CODES);
export type AsciicastEventCode = z.infer<typeof AsciicastEventCodeSchema>;

/**
 * One asciicast event line: `[time, code, data]`.
 * `time` is cumulative seconds (float) since the recording start.
 */
export const AsciicastEventSchema = z.tuple([
  z.number(),
  AsciicastEventCodeSchema,
  z.string(),
]);
export type AsciicastEvent = z.infer<typeof AsciicastEventSchema>;

/** `Content-Type` the cast read endpoint serves (the raw asciicast JSONL text). */
export const CAST_CONTENT_TYPE = 'text/plain; charset=utf-8';

/**
 * REST path for a task's cast, RELATIVE (no leading slash) — matching the
 * `tasks/:id/session-history` convention. The empty-signal contract: an
 * available cast returns its JSONL text; a task with no recording returns an
 * EMPTY body (the player renders the honest empty face on empty/whitespace).
 */
export function castEndpointPath(taskId: string): string {
  return `tasks/${taskId}/cast`;
}

/** Parse one header line. Returns null on malformed / non-matching JSON. */
export function parseAsciicastHeader(line: string): AsciicastHeader | null {
  try {
    const result = AsciicastHeaderSchema.safeParse(JSON.parse(line));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Parse one event line. Returns null on malformed JSON / shape, so a single bad
 * line never aborts the whole parse (best-effort read of a recorded file).
 */
export function parseAsciicastEvent(line: string): AsciicastEvent | null {
  try {
    const result = AsciicastEventSchema.safeParse(JSON.parse(line));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** A parsed cast: the header (null if missing/invalid) + the ordered events. */
export interface ParsedCast {
  header: AsciicastHeader | null;
  events: AsciicastEvent[];
}

/**
 * Parse a whole cast text into `{ header, events }`. Blank lines are skipped and
 * malformed event lines are dropped (never throws). The first non-blank line is
 * the header; the rest are events in recorded order.
 */
export function parseCast(text: string): ParsedCast {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const first = lines[0];
  if (first === undefined) return { header: null, events: [] };
  const header = parseAsciicastHeader(first);
  const events: AsciicastEvent[] = [];
  for (const line of lines.slice(1)) {
    const event = parseAsciicastEvent(line);
    if (event) events.push(event);
  }
  return { header, events };
}

/** Total duration (seconds) of a parsed cast — the last event's `time`, or 0. */
export function castDurationSeconds(events: AsciicastEvent[]): number {
  const last = events[events.length - 1];
  return last ? last[0] : 0;
}
