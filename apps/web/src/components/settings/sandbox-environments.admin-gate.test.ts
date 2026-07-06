import { describe, expect, it } from "vitest";
import type { SessionUser } from "@cap/contracts";

import { shouldShowAdminSettingsSections } from "../../routes/_app/settings";

function session(role: SessionUser["role"], allowed = true): SessionUser {
  return {
    id: "u_test",
    name: "test",
    githubId: null,
    role,
    allowed,
    login: "test@example.com",
    avatarUrl: null,
    mustChangePassword: false,
  };
}

describe("settings admin-only sandbox environment section gate", () => {
  it("allows admin sessions", () => {
    expect(shouldShowAdminSettingsSections(session("admin"))).toBe(true);
  });

  it("rejects non-admin and blocked sessions", () => {
    expect(shouldShowAdminSettingsSections(session("member"))).toBe(false);
    expect(shouldShowAdminSettingsSections(session("admin", false))).toBe(false);
    expect(shouldShowAdminSettingsSections(undefined)).toBe(false);
  });
});
