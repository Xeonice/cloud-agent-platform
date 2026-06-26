/**
 * Minimal ground-truth test: "Settings page has an admin-only Resend SMTP section"
 * (add-smtp-config-ui requirement).
 *
 * The gate lives in `src/routes/_app/settings.tsx`:
 *
 *   const isAdmin = isAdminSession(session ?? undefined);
 *   ...
 *   {isAdmin ? <section id="smtp"><SmtpConfigCard /></section> : null}
 *
 * The predicate is `isAdminSession` from `components/shell/update-banner.tsx`.
 * This test exercises that function directly — the SAME function the settings page
 * calls — covering the four cases that determine whether the SMTP section mounts.
 *
 * Pure node environment: no DOM, no React render, no window.
 */
import { describe, it, expect } from "vitest";
import { isAdminSession } from "../shell/update-banner";
import type { SessionUser } from "@cap/contracts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal session-user fixture. */
function session(login: string | null, allowed = true): SessionUser {
  return {
    id: "u_test",
    name: login ?? "test",
    githubId: null,
    role: "member",
    allowed,
    login,
    avatarUrl: null,
    mustChangePassword: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("isAdminSession — the gate that controls the SMTP section visibility", () => {
  it("returns true for an admin session → SMTP section IS rendered", () => {
    const s = { ...session("alice"), role: "admin" as const };
    // The settings page: isAdmin = isAdminSession(session); {isAdmin ? <SmtpSection /> : null}
    expect(isAdminSession(s)).toBe(true);
  });

  it("returns false for a non-admin session → SMTP section is NOT rendered", () => {
    const s = session("charlie");
    expect(isAdminSession(s)).toBe(false);
  });

  it("returns false when session is undefined (logged-out / not yet resolved)", () => {
    expect(isAdminSession(undefined)).toBe(false);
  });

  it("returns false when session.allowed is false (blocked account)", () => {
    const s = { ...session("alice", false), role: "admin" as const };
    expect(isAdminSession(s)).toBe(false);
  });
});
