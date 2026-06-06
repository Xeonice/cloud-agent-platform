/**
 * Deterministic time/duration formatting for the history page (Track 15).
 *
 * Two distinct concerns, both kept SSR-safe:
 *
 *   - {@link formatClock} renders a stored `Date` as `HH:MM:SS` (UTC) for the
 *     event timeline. It reads the Date's UTC fields (no `Date.now()`, no
 *     locale-dependent formatter, no LOCAL-timezone getters), so the output is
 *     a pure function of the immutable timestamp and is byte-identical on the
 *     server and the first client render REGARDLESS of each process's timezone
 *     — no hydration mismatch even when the Nitro/Node server runs in UTC and
 *     the browser is in another zone. UTC is the natural frame for an audit log
 *     and matches the server-authoritative timestamps.
 *
 *   - {@link formatElapsed} renders a `createdAt → now` span as the prototype's
 *     compact `42m` / `1h 08m` 耗时 form. Because it depends on the CURRENT time
 *     it is NEVER called during render or at module top-level; the page computes
 *     it inside a `useEffect`-driven `now` state so SSR (where `now` is absent)
 *     shows the `—` placeholder and the client fills it in after mount.
 */

/** Two-digit zero-padded string for a clock/duration field (`7` → `"07"`). */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Format a stored timestamp as `HH:MM:SS` using the Date's UTC fields.
 * Deterministic for a given `Date` (no `Date.now()`, no LOCAL-timezone getters),
 * so the produced string depends ONLY on the immutable instant — never on the
 * host process's timezone. This makes it safe to call during render on both the
 * server and the client: SSR and the first client render are byte-identical even
 * when the server and the browser sit in different time zones.
 */
export function formatClock(date: Date): string {
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(
    date.getUTCSeconds(),
  )}`;
}

/**
 * Format the elapsed span between `createdAt` and `now` as the prototype's
 * compact 耗时 string: `42m` under an hour, else `1h 08m` (minutes zero-padded).
 * Returns `"—"` when the span is unknown (no `now` yet — pre-mount) or negative
 * (a clock skew / future timestamp), so the page never shows a fabricated value.
 *
 * `now` is passed in explicitly (never read off the global clock here) so this
 * stays a pure function — the caller owns when "now" is sampled.
 */
export function formatElapsed(
  createdAt: Date,
  now: number | undefined,
): string {
  if (now == null) return "—";
  const ms = now - createdAt.getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  return `${hours}h ${pad2(minutes)}m`;
}
