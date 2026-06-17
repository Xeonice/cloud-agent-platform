import { describe, it, expect } from "vitest";
import { updateStatusQuery } from "./queries";

/**
 * responsive-update-check D2 — the update-status query must POLL (interval +
 * window-focus refetch) so a newly-published Release surfaces in the app-shell
 * banner without a manual reload. (queryFn is a closure and is NOT invoked here,
 * so this is a pure options assertion — no network / capability resolution.)
 */
describe("updateStatusQuery polling (responsive-update-check)", () => {
  it("polls on a minutes-scale interval and refetches on window focus", () => {
    const q = updateStatusQuery();
    expect(q.refetchInterval).toBe(5 * 60 * 1000);
    expect(q.refetchOnWindowFocus).toBe(true);
  });
});
