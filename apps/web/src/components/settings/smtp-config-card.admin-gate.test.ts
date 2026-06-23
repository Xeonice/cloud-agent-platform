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
import type { AuthSession } from "@cap/contracts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal AuthSession fixture. */
function session(login: string | null, allowed = true): AuthSession {
  return {
    id: "u_test",
    name: login ?? "test",
    githubId: null,
    role: "member",
    allowed,
    login,
    avatarUrl: null,
    mustChangePassword: false,
  } as AuthSession;
}

// The admin allowlist used by the settings page (passed explicitly so the test
// is independent of the VITE_ADMIN_LOGINS build-time env variable).
const ADMIN_LIST = ["alice", "bob"] as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("isAdminSession — the gate that controls the SMTP section visibility", () => {
  it("returns true for a known-admin session → SMTP section IS rendered", () => {
    const s = session("alice");
    // The settings page: isAdmin = isAdminSession(session); {isAdmin ? <SmtpSection /> : null}
    expect(isAdminSession(s, ADMIN_LIST)).toBe(true);
  });

  it("returns false for a non-admin session → SMTP section is NOT rendered", () => {
    const s = session("charlie"); // not in the allowlist
    expect(isAdminSession(s, ADMIN_LIST)).toBe(false);
  });

  it("returns false when session is undefined (logged-out / not yet resolved)", () => {
    expect(isAdminSession(undefined, ADMIN_LIST)).toBe(false);
  });

  it("returns false when the allowlist is empty (no admins configured)", () => {
    const s = session("alice");
    expect(isAdminSession(s, [])).toBe(false);
  });

  it("returns false when session.allowed is false (blocked account)", () => {
    const s = session("alice", false);
    expect(isAdminSession(s, ADMIN_LIST)).toBe(false);
  });

  it("is case-insensitive — 'Alice' matches allowlist entry 'alice'", () => {
    // The settings page receives a session whose login may have mixed case.
    const s = session("Alice");
    expect(isAdminSession(s, ADMIN_LIST)).toBe(true);
  });

  it("returns false when session.login is null (local password/OTP account with no GitHub handle)", () => {
    // A local account has no GitHub login — cannot match the GitHub-login allowlist.
    const s = session(null);
    expect(isAdminSession(s, ADMIN_LIST)).toBe(false);
  });
});
