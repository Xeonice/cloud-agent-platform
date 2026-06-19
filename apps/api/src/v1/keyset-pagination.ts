import { BadRequestException } from '@nestjs/common';
import { V1_LIST_DEFAULT_LIMIT, V1_LIST_MAX_LIMIT } from '@cap/contracts';

/**
 * Keyset (cursor) pagination over the unique `(createdAt, id)` tuple
 * (public-v1-api, D4 / task 3.2).
 *
 * The `/v1` list endpoints (`GET /v1/tasks`, `GET /v1/repos`) page through the
 * SHARED, mutating task/repo pool. `createdAt` alone is NOT unique, so paging on
 * it would drop or duplicate rows at a page boundary when two rows share a
 * timestamp; the `(createdAt, id)` tuple is strictly ordered and stable, so a
 * cursor pinned to it never drops or duplicates a row even as the pool mutates
 * between page fetches.
 *
 * The cursor is OPAQUE on the wire: a base64url-encoded `"<createdAtISO>|<id>"`
 * pair. Callers treat it as a token and pass the prior page's `nextCursor` back
 * as `?cursor=` — they never construct or parse it. A malformed/garbage cursor
 * is a client error (400), never a silent reset to page one (which would
 * re-walk already-seen rows).
 *
 * This module is pure (no Nest/Prisma imports beyond the 400 exception type) so
 * the controllers can compose the `where`/`orderBy`/`take` fragments and the
 * `nextCursor` computation without re-deriving the keyset invariants per route.
 */

/** The decoded keyset position a page resumes strictly AFTER. */
export interface KeysetCursor {
  readonly createdAt: Date;
  readonly id: string;
}

/** Field-character that separates the two tuple components inside a cursor. */
const CURSOR_SEPARATOR = '|';

/**
 * Encodes a `(createdAt, id)` position into the opaque base64url cursor returned
 * to clients as `nextCursor`. The ISO timestamp preserves millisecond precision
 * so the decoded `Date` reconstructs the exact stored value the next page
 * compares against.
 */
export function encodeCursor(position: KeysetCursor): string {
  const raw = `${position.createdAt.toISOString()}${CURSOR_SEPARATOR}${position.id}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/**
 * Decodes an opaque cursor produced by {@link encodeCursor} back into its
 * `(createdAt, id)` position. Throws {@link BadRequestException} (400) for any
 * malformed token — bad base64, a missing separator, or an unparseable date —
 * so a corrupt cursor surfaces as a client error rather than silently restarting
 * pagination from the first page (which would re-emit already-seen rows).
 */
export function decodeCursor(cursor: string): KeysetCursor {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new BadRequestException('Invalid cursor');
  }

  const sep = raw.indexOf(CURSOR_SEPARATOR);
  if (sep <= 0 || sep === raw.length - 1) {
    throw new BadRequestException('Invalid cursor');
  }

  const createdAtIso = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  const createdAt = new Date(createdAtIso);
  if (Number.isNaN(createdAt.getTime())) {
    throw new BadRequestException('Invalid cursor');
  }

  return { createdAt, id };
}

/**
 * Clamps a requested page size to `[1, V1_LIST_MAX_LIMIT]`, falling back to
 * {@link V1_LIST_DEFAULT_LIMIT} when absent. The contract `V1ListQuerySchema`
 * already coerces + bounds `limit`, so this is a defensive backstop for callers
 * that build the query object directly (and the single source of the default).
 */
export function resolveLimit(limit?: number): number {
  if (limit === undefined || Number.isNaN(limit)) {
    return V1_LIST_DEFAULT_LIMIT;
  }
  const floored = Math.floor(limit);
  if (floored < 1) {
    return 1;
  }
  if (floored > V1_LIST_MAX_LIMIT) {
    return V1_LIST_MAX_LIMIT;
  }
  return floored;
}

/**
 * The Prisma `where` fragment that resumes strictly AFTER a decoded cursor in
 * `(createdAt, id)` ascending order, expressing the lexicographic comparison
 * `(createdAt, id) > (cursor.createdAt, cursor.id)`:
 *
 *   createdAt > c.createdAt
 *   OR (createdAt = c.createdAt AND id > c.id)
 *
 * Returns an empty object on the first page (no cursor) so the caller spreads it
 * unconditionally. The tie-break on `id` is what makes a same-timestamp boundary
 * lossless.
 */
export function cursorWhere(
  cursor: KeysetCursor | undefined,
): Record<string, unknown> {
  if (!cursor) {
    return {};
  }
  return {
    OR: [
      { createdAt: { gt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { gt: cursor.id } },
    ],
  };
}

/** The stable ascending `(createdAt, id)` ordering every `/v1` page uses. */
export const KEYSET_ORDER_BY = [
  { createdAt: 'asc' as const },
  { id: 'asc' as const },
];

/**
 * Splits an over-fetched row set (queried with `take: limit + 1`) into the page
 * to return and the `nextCursor`. When the fetch yielded MORE than `limit` rows
 * there is a next page, so the extra sentinel row is dropped and `nextCursor`
 * encodes the last RETURNED row's position; otherwise this is the last page and
 * `nextCursor` is `null`.
 *
 * The +1 over-fetch is what lets a single query decide whether a next page
 * exists without a second `count` round-trip.
 */
export function buildPage<T extends { createdAt: Date; id: string }>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  if (rows.length > limit) {
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: encodeCursor({ createdAt: last.createdAt, id: last.id }),
    };
  }
  return { items: rows, nextCursor: null };
}
