/**
 * Unit test for the transcript-timeline pure logic (wire-transcript-real-data,
 * Track web). Covers the filter/search/format rules the `/tasks/$taskId/transcript`
 * route renders off REAL `SessionTurn`s — the type filter and free-text search
 * narrowing TOGETHER, the per-kind classification, and the clock/duration
 * formatting. The route's render + `taskId` wiring is covered by the Playwright
 * visual gate (the repo's vitest suite is node-env, no DOM).
 */
import { describe, it, expect } from "vitest";
import type { SessionTurn } from "@cap/contracts";

import {
  clock,
  formatDuration,
  searchText,
  passesFilter,
  filterTurns,
} from "./transcript-timeline";

const sysTurn: SessionTurn = {
  kind: "system",
  title: "任务创建",
  detail: "repo · branch",
  at: "2026-06-12T09:30:00Z",
  level: "info",
};
const userTurn: SessionTurn = { kind: "user", text: "修复登录页", at: "2026-06-12T09:30:05Z" };
const commentTurn: SessionTurn = {
  kind: "assistant",
  text: "先看相关文件",
  isFinalAnswer: false,
  at: "2026-06-12T09:30:10Z",
};
const toolTurn: SessionTurn = {
  kind: "tool",
  name: "apply_patch",
  args: "*** Update File: login.css",
  output: "Success",
  at: "2026-06-12T09:30:35Z",
  diffstat: { add: 1, del: 1 },
};
const answerTurn: SessionTurn = {
  kind: "assistant",
  text: "已修复登录页样式",
  isFinalAnswer: true,
  at: "2026-06-12T09:31:00Z",
};
const TURNS: SessionTurn[] = [sysTurn, userTurn, commentTurn, toolTurn, answerTurn];

describe("transcript-timeline filter + search", () => {
  it("'all' includes every kind (system milestones too)", () => {
    expect(filterTurns(TURNS, "all", "")).toHaveLength(5);
  });

  it("'user' keeps only user turns", () => {
    const out = filterTurns(TURNS, "user", "");
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("user");
  });

  it("'tool' keeps only tool turns", () => {
    const out = filterTurns(TURNS, "tool", "");
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("tool");
  });

  it("'answer' keeps only the FINAL-answer assistant turn (not commentary)", () => {
    const out = filterTurns(TURNS, "answer", "");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "assistant", isFinalAnswer: true });
  });

  it("filter AND search narrow TOGETHER", () => {
    // search alone (over all kinds) matches only the tool turn's args.
    expect(filterTurns(TURNS, "all", "login.css")).toHaveLength(1);
    // 'user' filter + a query only the tool turn carries → empty (both must pass).
    expect(filterTurns(TURNS, "user", "login.css")).toHaveLength(0);
    // 'user' filter + a query the user turn carries → the user turn.
    expect(filterTurns(TURNS, "user", "登录")).toHaveLength(1);
  });

  it("an empty/whitespace query matches everything; search is case-insensitive", () => {
    expect(filterTurns(TURNS, "all", "   ")).toHaveLength(5);
    expect(filterTurns(TURNS, "all", "SUCCESS")).toHaveLength(1); // tool output, case-insensitive
  });
});

describe("passesFilter / searchText per kind", () => {
  it("classifies each kind under its filter", () => {
    expect(passesFilter(sysTurn, "all")).toBe(true);
    expect(passesFilter(sysTurn, "user")).toBe(false);
    expect(passesFilter(userTurn, "user")).toBe(true);
    expect(passesFilter(toolTurn, "tool")).toBe(true);
    expect(passesFilter(answerTurn, "answer")).toBe(true);
    expect(passesFilter(commentTurn, "answer")).toBe(false); // commentary is NOT an answer
  });

  it("searchText concatenates the kind's text fields", () => {
    expect(searchText(sysTurn)).toContain("任务创建");
    expect(searchText(sysTurn)).toContain("repo · branch");
    expect(searchText(toolTurn)).toContain("apply_patch");
    expect(searchText(toolTurn)).toContain("Success");
  });
});

describe("clock / formatDuration", () => {
  it("clock extracts the UTC HH:MM:SS slice (deterministic)", () => {
    expect(clock("2026-06-12T09:30:05Z")).toBe("09:30:05");
    expect(clock(undefined)).toBe("");
    expect(clock("not-a-timestamp")).toBe("");
  });

  it("formatDuration renders compact minutes/seconds", () => {
    expect(formatDuration(65000)).toBe("1m 05s");
    expect(formatDuration(35000)).toBe("35s");
    expect(formatDuration(3725000)).toBe("62m 05s");
  });
});
