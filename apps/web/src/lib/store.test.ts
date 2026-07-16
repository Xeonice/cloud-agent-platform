/**
 * Store pure-helper tests (rebuild-console-tanstack-start task 10.8, supporting
 * the "derived state stays pure / out of cache" contract).
 *
 * `normalizeState` and `upsertImportedRepo` are the store's pure, React-free,
 * `window`-free transforms (the persisted-shape defense + the de-duplicating
 * import insert). They are unit-testable directly; these tests pin their
 * invariants (drop unknown keys, de-dup imported repos by id, "unique default"
 * via `selectedRepo`, clamp retention) without touching `localStorage`.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeState,
  upsertImportedRepo,
  DEFAULT_STATE,
} from "./store";
import type { ImportedRepo } from "./store";

describe("normalizeState", () => {
  it("returns DEFAULT_STATE for non-object / null input", () => {
    expect(normalizeState(null)).toEqual(DEFAULT_STATE);
    expect(normalizeState(undefined)).toEqual(DEFAULT_STATE);
    expect(normalizeState("nonsense")).toEqual(DEFAULT_STATE);
    expect(normalizeState(42)).toEqual(DEFAULT_STATE);
  });

  it("drops unknown keys and keeps only the known persisted shape", () => {
    const out = normalizeState({
      githubConnected: true,
      bogusKey: "should be dropped",
      importedRepos: [],
    });
    expect(out.githubConnected).toBe(true);
    expect(out).not.toHaveProperty("bogusKey");
    // Shape is exactly the known keys.
    expect(Object.keys(out).sort()).toEqual(
      [
        "githubConnected",
        "importedRepos",
        "selectedRepo",
        "selectedBranch",
        "latestRunId",
        "settings",
        "codexCredential",
        "claudeCredential",
      ].sort(),
    );
  });

  it("de-duplicates imported repos by id (first occurrence wins)", () => {
    const out = normalizeState({
      importedRepos: [
        { id: "r1", name: "first", fullName: "o/first", defaultBranch: "main" },
        { id: "r1", name: "dup", fullName: "o/dup", defaultBranch: "dev" },
        { id: "r2", name: "second", fullName: "o/second", defaultBranch: "main" },
      ],
    });
    expect(out.importedRepos).toHaveLength(2);
    expect(out.importedRepos[0]!.name).toBe("first"); // first id wins
    expect(out.importedRepos.map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("clears selectedRepo unless it still references an imported repo (unique default)", () => {
    const dangling = normalizeState({
      importedRepos: [
        { id: "r1", name: "a", fullName: "o/a", defaultBranch: "main" },
      ],
      selectedRepo: "does-not-exist",
    });
    expect(dangling.selectedRepo).toBeNull();

    const valid = normalizeState({
      importedRepos: [
        { id: "r1", name: "a", fullName: "o/a", defaultBranch: "main" },
      ],
      selectedRepo: "r1",
    });
    expect(valid.selectedRepo).toBe("r1");
  });

  it("keeps only verified branch and task-id recovery values", () => {
    const valid = normalizeState({
      selectedBranch: "master",
      latestRunId: "00000000-0000-4000-8000-000000000123",
      importedRepos: [
        { id: "legacy", name: "legacy", fullName: "o/legacy" },
        {
          id: "verified",
          name: "verified",
          fullName: "o/verified",
          defaultBranch: "master",
        },
      ],
    });
    expect(valid.selectedBranch).toBe("master");
    expect(valid.latestRunId).toBe("00000000-0000-4000-8000-000000000123");
    expect(valid.importedRepos.map((repo) => repo.defaultBranch)).toEqual([
      null,
      "master",
    ]);

    const invalid = normalizeState({
      selectedBranch: "--invalid",
      latestRunId: "not-a-task-id",
      importedRepos: [
        {
          id: "invalid",
          name: "invalid",
          fullName: "o/invalid",
          defaultBranch: "bad branch",
        },
      ],
    });
    expect(invalid.selectedBranch).toBeNull();
    expect(invalid.latestRunId).toBeNull();
    expect(invalid.importedRepos[0]?.defaultBranch).toBeNull();
  });

  it("clamps an invalid retention to the 30-day default", () => {
    expect(normalizeState({ settings: { retention: 999 } }).settings.retention).toBe(30);
    expect(normalizeState({ settings: { retention: 90 } }).settings.retention).toBe(90);
  });

  it("does not mutate its input", () => {
    const input = {
      githubConnected: true,
      importedRepos: [
        { id: "r1", name: "a", fullName: "o/a", defaultBranch: "main" },
      ],
    };
    const snapshot = structuredClone(input);
    normalizeState(input);
    expect(input).toEqual(snapshot);
  });
});

describe("upsertImportedRepo", () => {
  const repo: ImportedRepo = {
    id: "r1",
    name: "a",
    fullName: "o/a",
    defaultBranch: "main",
  };

  it("appends a new repo, returning a new array (no mutation)", () => {
    const list: ImportedRepo[] = [];
    const out = upsertImportedRepo(list, repo);
    expect(out).toHaveLength(1);
    expect(out).not.toBe(list);
    expect(list).toHaveLength(0); // input untouched
  });

  it("is idempotent on an existing id (first id wins, no duplicate)", () => {
    const list: ImportedRepo[] = [repo];
    const out = upsertImportedRepo(list, {
      ...repo,
      name: "changed",
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("a"); // existing entry preserved
    expect(out).not.toBe(list); // still a fresh array
  });
});
