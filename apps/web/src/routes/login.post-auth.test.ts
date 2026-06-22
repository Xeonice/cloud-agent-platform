/**
 * Ground-truth test: post-auth navigation uses a FULL DOCUMENT LOAD
 * (fix-login-redirect, spec frontend-console §"Post-login navigation performs a
 * full document load").
 *
 * The bug: password/OTP login + forced-change completion used a soft router
 * navigate into the `_app` gate, which read a landing-prewarmed STALE `authSession`
 * cache and bounced the fresh session back to `/login`. The fix routes both paths
 * through `enterConsole`, which calls `window.location.assign` — a full page load
 * that discards the cache so the gate re-resolves from the existing cookie.
 *
 * Strategy mirrors `_app.auth-gate.test.ts`: exercise the extracted seam directly
 * in the node env (stubbing a minimal `window`) rather than mounting the
 * router/React. Asserting `window.location.assign` is what proves the FULL-LOAD
 * contract (a soft navigate would never touch it).
 */
import { describe, it, expect, vi, afterEach } from "vitest";

import { enterConsole } from "./login";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Stub a minimal `window` and return the `location.assign` spy. */
function spyAssign() {
  const assign = vi.fn();
  vi.stubGlobal("window", { location: { assign } });
  return assign;
}

describe("enterConsole — full-document-load seam", () => {
  it("enters via a full page load (window.location.assign), not a soft navigate", () => {
    const assign = spyAssign();
    enterConsole("/dashboard");
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/dashboard");
  });

  it("threads a same-origin relative redirect deep-link through unchanged", () => {
    const assign = spyAssign();
    enterConsole("/tasks/abc");
    expect(assign).toHaveBeenCalledWith("/tasks/abc");
  });

  it("falls back to /dashboard when no redirect is carried", () => {
    const assign = spyAssign();
    enterConsole(undefined);
    expect(assign).toHaveBeenCalledWith("/dashboard");
  });

  it("rejects an off-site redirect (open-redirect guard) and falls back to /dashboard", () => {
    const assign = spyAssign();
    enterConsole("https://evil.example/phish");
    expect(assign).toHaveBeenCalledWith("/dashboard");
  });
});
