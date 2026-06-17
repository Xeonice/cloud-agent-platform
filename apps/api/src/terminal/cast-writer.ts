/**
 * Pure asciicast v2 line builders (session-terminal-replay, Track 2).
 *
 * The gateway records terminal output to a per-task `session.cast` as asciicast
 * v2. These builders are PURE (no fs, no state) so they unit-test in isolation;
 * the gateway owns the stateful, best-effort append (the tail chain + fs writes).
 *
 * asciicast v2 (docs.asciinema.org/manual/asciicast/v2/): the file's first line
 * is a header object; each later line is an event tuple `[time, code, data]`,
 * `time` = cumulative seconds since start, `data` = valid-UTF-8 JSON string.
 */

import type { AsciicastEventCode } from '@cap/contracts';

/**
 * The first line of a `session.cast`: the asciicast v2 header carrying the
 * recording geometry (`width`/`height`) and a start `timestamp` (epoch seconds).
 * Newline-terminated, ready to append.
 */
export function buildCastHeaderLine(
  cols: number,
  rows: number,
  timestampSec: number,
): string {
  return (
    JSON.stringify({
      version: 2,
      width: cols,
      height: rows,
      timestamp: timestampSec,
      env: { TERM: 'xterm-256color' },
    }) + '\n'
  );
}

/**
 * One asciicast event line `[time, code, data]`, newline-terminated. `data` is
 * JSON-escaped by `JSON.stringify`, so any already-decoded UTF-8 string (the
 * gateway receives PTY output as a decoded string) round-trips through
 * `JSON.parse` byte-for-byte — multibyte chars included.
 */
export function buildCastEventLine(
  timeSec: number,
  code: AsciicastEventCode,
  data: string,
): string {
  return JSON.stringify([timeSec, code, data]) + '\n';
}

/** The asciicast `r` (resize) event data string for a geometry: `"COLSxROWS"`. */
export function castResizeData(cols: number, rows: number): string {
  return `${cols}x${rows}`;
}
