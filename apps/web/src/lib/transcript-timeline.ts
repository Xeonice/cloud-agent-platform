/**
 * Pure timeline logic for the `/tasks/$taskId/transcript` route
 * (wire-transcript-real-data). Extracted from the route component so the
 * filter/search/format rules are unit-testable in the repo's node-env vitest
 * suite (the route's RENDER + `taskId` wiring is covered end-to-end by the
 * Playwright visual gate; this module owns the logic).
 */
import type { SessionTurn } from "@cap/contracts";

/** Transcript type-filter values (UI: 全部 / 我的输入 / 工具 / 回答). */
export type TranscriptFilter = "all" | "user" | "tool" | "answer";

/** The HH:MM:SS slice of an ISO timestamp (UTC, SSR-deterministic; "" if none). */
export function clock(at: string | undefined): string {
  if (!at) return "";
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(at);
  return m?.[1] ?? "";
}

/** Compact `Xm Ys` / `Ys` duration from a millisecond span. */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

/** A turn's concatenated, lower-cased search haystack. */
export function searchText(turn: SessionTurn): string {
  switch (turn.kind) {
    case "user":
    case "assistant":
      return turn.text;
    case "tool":
      return [turn.name, turn.args, turn.output ?? ""].join(" ");
    case "system":
      return [turn.title, turn.detail ?? ""].join(" ");
  }
}

/** Does a turn pass the active type filter? `all` includes system milestones. */
export function passesFilter(turn: SessionTurn, filter: TranscriptFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "user":
      return turn.kind === "user";
    case "tool":
      return turn.kind === "tool";
    case "answer":
      return turn.kind === "assistant" && turn.isFinalAnswer;
  }
}

/**
 * The visible turns: the type filter AND the free-text search applied TOGETHER
 * (both must pass). The query is trimmed + lower-cased; an empty query matches
 * everything.
 */
export function filterTurns(
  turns: readonly SessionTurn[],
  filter: TranscriptFilter,
  rawQuery: string,
): SessionTurn[] {
  const query = rawQuery.trim().toLowerCase();
  return turns.filter(
    (turn) =>
      passesFilter(turn, filter) &&
      (query === "" || searchText(turn).toLowerCase().includes(query)),
  );
}
