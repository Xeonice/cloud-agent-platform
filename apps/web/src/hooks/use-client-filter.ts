/**
 * Client-side filter hook (rebuild-console-tanstack-start task 10.7; 15.3).
 *
 * A SEARCH box + a `level`/`status` segmented control + a live visible-count,
 * derived purely with `useMemo` from data already in the Query cache. Shared by
 * the history page (filters the audit timeline AND the recent-tasks table from
 * one control) and the dashboard. This is strictly a VIEW concern: it never
 * touches the Query cache and never triggers a fetch (D5.4 — derived filters
 * stay out of the cache), so toggling a filter is instant and does not refetch.
 *
 * The matching predicate is factored out as a PURE function ({@link filterItems})
 * so it is unit-testable without React.
 */
import { useMemo, useState } from "react";
import type { AuditLevel, TaskStatus } from "@cap/contracts";

/** The "all" sentinel for a segmented control (the prototype's 全部). */
export const ALL = "all" as const;
export type LevelFilter = AuditLevel | typeof ALL;
export type StatusFilter = TaskStatus | typeof ALL;

/** The live filter state a segmented + search control drives. */
export interface ClientFilterState {
  /** Free-text search query (case-insensitive substring over searchable text). */
  search: string;
  /** Severity segment, or `all`. */
  level: LevelFilter;
  /** Task-status segment, or `all`. */
  status: StatusFilter;
}

/** How to read the filterable facets off an item of type `T`. */
export interface FilterAccessors<T> {
  /** Strings to match the search query against (title/description/repo/etc.). */
  text: (item: T) => Array<string | null | undefined>;
  /** The item's severity level, when it has one. */
  level?: (item: T) => AuditLevel | null | undefined;
  /** The item's task status, when it has one. */
  status?: (item: T) => TaskStatus | null | undefined;
}

/**
 * PURE filter: returns the subset of `items` matching the `state`. An accessor
 * that is absent (or returns nullish) means that facet does not constrain the
 * item — so a `level` filter only narrows items that actually carry a level.
 * Search is a case-insensitive substring match across all `text` accessors.
 * No React, no cache — directly unit-testable.
 */
export function filterItems<T>(
  items: readonly T[],
  state: ClientFilterState,
  accessors: FilterAccessors<T>,
): T[] {
  const needle = state.search.trim().toLowerCase();
  return items.filter((item) => {
    if (state.level !== ALL && accessors.level) {
      const lvl = accessors.level(item);
      if (lvl != null && lvl !== state.level) return false;
    }
    if (state.status !== ALL && accessors.status) {
      const st = accessors.status(item);
      if (st != null && st !== state.status) return false;
    }
    if (needle.length > 0) {
      const haystack = accessors
        .text(item)
        .filter((s): s is string => typeof s === "string")
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

/** What {@link useClientFilter} returns: state, setters, derived view, count. */
export interface UseClientFilterResult<T> {
  state: ClientFilterState;
  setSearch: (search: string) => void;
  setLevel: (level: LevelFilter) => void;
  setStatus: (status: StatusFilter) => void;
  reset: () => void;
  /** The filtered subset (memoized; recomputed only when inputs change). */
  visible: T[];
  /** Live count of visible items (`visible.length`). */
  visibleCount: number;
  /** Total count before filtering (`items.length`). */
  totalCount: number;
}

/**
 * The shared filter hook. Holds the (search/level/status) state locally and
 * returns the `useMemo`-derived `visible` subset + live counts. Because the
 * derivation is `useMemo` over the passed-in `items` (which come from the Query
 * cache) and the local filter state, no cache write or fetch ever occurs.
 *
 * Pass the SAME hook instance's `state` + a second `filterItems` call to drive a
 * second list (e.g. the history page's table + timeline) from one control.
 */
export function useClientFilter<T>(
  items: readonly T[],
  accessors: FilterAccessors<T>,
  initial?: Partial<ClientFilterState>,
): UseClientFilterResult<T> {
  const [state, setState] = useState<ClientFilterState>({
    search: initial?.search ?? "",
    level: initial?.level ?? ALL,
    status: initial?.status ?? ALL,
  });

  const visible = useMemo(
    () => filterItems(items, state, accessors),
    // `accessors` is expected to be stable (declared at module/render-top level);
    // it is included so a genuinely changed accessor set re-derives.
    [items, state, accessors],
  );

  return {
    state,
    setSearch: (search) => setState((s) => ({ ...s, search })),
    setLevel: (level) => setState((s) => ({ ...s, level })),
    setStatus: (status) => setState((s) => ({ ...s, status })),
    reset: () => setState({ search: "", level: ALL, status: ALL }),
    visible,
    visibleCount: visible.length,
    totalCount: items.length,
  };
}
