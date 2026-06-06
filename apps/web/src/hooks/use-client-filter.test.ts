/**
 * Derived-filter tests (rebuild-console-tanstack-start task 10.8, contract #3).
 *
 * Proves the client filter derivation is a PURE projection over its inputs
 * (items + search/level/status state) — it derives the visible subset + count
 * WITHOUT mutating the source items and WITHOUT any cache/fetch (D5.4: derived
 * filters stay out of the cache). The hook factors the predicate out as the pure
 * `filterItems(items, state, accessors)` exactly so it is unit-testable without
 * React; we exercise that function directly (no render, no DOM needed).
 *
 * We do NOT change the hook's behavior — these tests only read it.
 */
import { describe, it, expect } from "vitest";
import { filterItems, ALL } from "./use-client-filter";
import type { ClientFilterState, FilterAccessors } from "./use-client-filter";
import type { AuditLevel, TaskStatus } from "@cap/contracts";

interface Row {
  title: string;
  description: string | null;
  level: AuditLevel;
  status: TaskStatus;
}

const rows: Row[] = [
  { title: "创建任务", description: "派发到 console", level: "info", status: "running" },
  { title: "进入队列", description: "信号量已满", level: "warning", status: "queued" },
  { title: "强制失败", description: "超过墙钟截止", level: "error", status: "failed" },
  { title: "等待审批", description: null, level: "warning", status: "awaiting_input" },
];

const accessors: FilterAccessors<Row> = {
  text: (r) => [r.title, r.description],
  level: (r) => r.level,
  status: (r) => r.status,
};

const base: ClientFilterState = { search: "", level: ALL, status: ALL };

describe("filterItems (the hook's pure derivation)", () => {
  it("returns all items when no facet constrains (search empty, level/status = all)", () => {
    const out = filterItems(rows, base, accessors);
    expect(out).toHaveLength(rows.length);
  });

  it("narrows by level without touching items that the facet does not match", () => {
    const out = filterItems(rows, { ...base, level: "warning" }, accessors);
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.level === "warning")).toBe(true);
  });

  it("narrows by status", () => {
    const out = filterItems(rows, { ...base, status: "failed" }, accessors);
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe("failed");
  });

  it("does a case-insensitive substring search across all text accessors", () => {
    // Matches a title.
    expect(
      filterItems(rows, { ...base, search: "队列" }, accessors),
    ).toHaveLength(1);
    // Matches a description, case-insensitively (no full-width case here, but
    // prove the lowercasing path on latin text).
    const latin: Row[] = [
      { title: "Build", description: "RUNNER reconnect", level: "info", status: "running" },
    ];
    expect(
      filterItems(latin, { ...base, search: "runner" }, accessors),
    ).toHaveLength(1);
  });

  it("trims whitespace-only searches to a no-op (returns everything)", () => {
    expect(filterItems(rows, { ...base, search: "   " }, accessors)).toHaveLength(
      rows.length,
    );
  });

  it("combines level + search conjunctively", () => {
    const out = filterItems(
      rows,
      { ...base, level: "warning", search: "队列" },
      accessors,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe("进入队列");
  });

  it("derives the visible COUNT as the length of the filtered subset", () => {
    const out = filterItems(rows, { ...base, level: "warning" }, accessors);
    // This is exactly what the hook exposes as `visibleCount`.
    expect(out.length).toBe(2);
  });

  it("is PURE: never mutates the source array or its items, and returns a new array", () => {
    const snapshot = structuredClone(rows);
    const out = filterItems(rows, { ...base, level: "error" }, accessors);
    // Source untouched (no in-place filtering / reordering / item edits).
    expect(rows).toEqual(snapshot);
    // A genuinely new array reference (derivation, not aliasing the cache).
    expect(out).not.toBe(rows);
  });

  it("does not constrain items whose accessor returns nullish for a facet", () => {
    // An item with no level accessor result is not excluded by a level filter.
    const noLevel: FilterAccessors<Row> = {
      text: (r) => [r.title],
      level: () => null,
      status: (r) => r.status,
    };
    const out = filterItems(rows, { ...base, level: "error" }, noLevel);
    expect(out).toHaveLength(rows.length);
  });
});
