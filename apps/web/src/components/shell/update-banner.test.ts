/**
 * Update-banner show/hide + per-version dismissal test (update-availability-
 * check, task 3.3).
 *
 * The banner's render contract is factored into the pure `selectBannerView`
 * decision (`update-banner.tsx`) so the three spec scenarios — appears on
 * `updateAvailable: true`, absent on `false`, dismissal is per-version — are
 * provable without a DOM. This exercises that function directly, mirroring the
 * suite's pure-logic, node-environment style (no React render, no `window`).
 *
 * A regression that always-showed (ignoring `updateAvailable`/`latestVersion`)
 * or that dismissed ACROSS versions (a global "dismissed" boolean instead of a
 * per-version match) would fail here — it is not a tautology.
 */
import { describe, it, expect } from "vitest";
import type { AuthSession, UpdateStatus } from "@cap/contracts";

import {
  isAdminSession,
  sameTag,
  selectBannerView,
  selectUpgradeAction,
  type UpdateBannerView,
} from "./update-banner";

describe("sameTag (post-upgrade /version match)", () => {
  it("matches the same release, tolerant of a leading v", () => {
    expect(sameTag("v0.3.2", "v0.3.2")).toBe(true);
    expect(sameTag("v0.3.2", "0.3.2")).toBe(true);
    expect(sameTag("0.3.2", "v0.3.2")).toBe(true);
  });
  it("rejects a different version and empty tags", () => {
    expect(sameTag("v0.3.2", "v0.3.1")).toBe(false);
    expect(sameTag("", "")).toBe(false);
    expect(sameTag("v", "")).toBe(false);
  });
});

/** An "update available for vY" status, overridable per case. */
function status(overrides: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    currentVersion: "v0.3.0",
    latestVersion: "v0.4.0",
    updateAvailable: true,
    releaseUrl:
      "https://github.com/Xeonice/cloud-agent-platform/releases/tag/v0.4.0",
    releaseName: "v0.4.0",
    checkedAt: "2026-06-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("selectBannerView — the banner's show/hide decision", () => {
  it("shows the banner when an update is available (carrying version + release link)", () => {
    const view = selectBannerView(status(), null);
    expect(view).not.toBeNull();
    expect(view?.version).toBe("v0.4.0");
    expect(view?.releaseUrl).toBe(
      "https://github.com/Xeonice/cloud-agent-platform/releases/tag/v0.4.0",
    );
    expect(view?.releaseName).toBe("v0.4.0");
  });

  it("hides the banner when no update is available", () => {
    // updateAvailable:false (up-to-date / unknown current — the api degrades all
    // such cases to this) ⇒ nothing rendered.
    expect(
      selectBannerView(
        status({ updateAvailable: false, latestVersion: null }),
        null,
      ),
    ).toBeNull();
  });

  it("hides the banner when there is no concrete latest version", () => {
    // No releases / fetch failure ⇒ latestVersion null, nothing to advertise.
    expect(
      selectBannerView(status({ updateAvailable: true, latestVersion: null }), null),
    ).toBeNull();
  });

  it("hides the banner when the status query has not resolved yet", () => {
    expect(selectBannerView(undefined, null)).toBeNull();
  });

  describe("dismissal is per-version", () => {
    it("hides the banner for the EXACT version that was dismissed", () => {
      // Operator dismissed vY (v0.4.0); the same offered version stays hidden.
      expect(selectBannerView(status({ latestVersion: "v0.4.0" }), "v0.4.0")).toBeNull();
    });

    it("re-surfaces the banner for a later, different version", () => {
      // A newer vZ (v0.5.0) becomes available after vY (v0.4.0) was dismissed —
      // it is a different version, so the banner re-appears.
      const view = selectBannerView(
        status({ latestVersion: "v0.5.0", releaseName: "v0.5.0" }),
        "v0.4.0",
      );
      expect(view).not.toBeNull();
      expect(view?.version).toBe("v0.5.0");
    });

    it("a dismissal does not suppress an unrelated earlier version offer", () => {
      // Dismissing v0.5.0 must not hide a (re-)offered v0.4.0 — the match is
      // exact, not 'any dismissal hides everything'.
      const view = selectBannerView(status({ latestVersion: "v0.4.0" }), "v0.5.0");
      expect(view).not.toBeNull();
      expect(view?.version).toBe("v0.4.0");
    });
  });
});

// ---------------------------------------------------------------------------
// Self-update upgrade action gate (self-update-action task 2.3)
// ---------------------------------------------------------------------------

/** An allowlisted session user, overridable per case. */
function session(overrides: Partial<NonNullable<AuthSession>> = {}): AuthSession {
  return {
    githubId: 4_829_173,
    login: "tanghehui",
    name: "Tang Hehui",
    avatarUrl: "https://avatars.githubusercontent.com/u/4829173?v=4",
    allowed: true,
    ...overrides,
  };
}

/** A non-null banner view (an update IS available for vY). */
const VIEW: UpdateBannerView = {
  version: "v0.4.0",
  releaseUrl:
    "https://github.com/Xeonice/cloud-agent-platform/releases/tag/v0.4.0",
  releaseName: "v0.4.0",
};

describe("isAdminSession — the banner's admin gate (env allowlist, design D2)", () => {
  it("is an admin when the allowlisted login is in the admin allowlist (case-insensitive)", () => {
    expect(isAdminSession(session({ login: "tanghehui" }), ["tanghehui"])).toBe(true);
    expect(isAdminSession(session({ login: "TangHehui" }), ["tanghehui"])).toBe(true);
  });

  it("is NOT an admin when the login is absent from the allowlist", () => {
    expect(isAdminSession(session({ login: "someoneelse" }), ["tanghehui"])).toBe(false);
  });

  it("fails closed for a logged-out / unresolved session", () => {
    expect(isAdminSession(null, ["tanghehui"])).toBe(false);
    expect(isAdminSession(undefined, ["tanghehui"])).toBe(false);
  });

  it("fails closed for a non-allowlisted session even if the login matches", () => {
    expect(isAdminSession(session({ allowed: false }), ["tanghehui"])).toBe(false);
  });

  it("fails closed when NO admins are configured (empty allowlist)", () => {
    // No admin set ⇒ nobody is admin (the shipped posture before activation).
    expect(isAdminSession(session(), [])).toBe(false);
  });
});

describe("selectUpgradeAction — present only when enabled + admin + update available", () => {
  it("is PRESENT when self-update is enabled, the operator is admin, and an update is available", () => {
    expect(
      selectUpgradeAction(VIEW, { selfUpdateEnabled: true, isAdmin: true }),
    ).toBe(true);
  });

  it("is ABSENT when self-update is DISABLED (the shipped, inert posture)", () => {
    // Even an admin with an available update sees no action while selfUpdate is off
    // — deploying the change adds no live host-root button (design D1/D5).
    expect(
      selectUpgradeAction(VIEW, { selfUpdateEnabled: false, isAdmin: true }),
    ).toBe(false);
  });

  it("is ABSENT for a NON-admin operator (even enabled + update available)", () => {
    expect(
      selectUpgradeAction(VIEW, { selfUpdateEnabled: true, isAdmin: false }),
    ).toBe(false);
  });

  it("is ABSENT when NO update is available (a null banner view)", () => {
    // No update to apply ⇒ the banner is notify-only; nothing to upgrade to.
    expect(
      selectUpgradeAction(null, { selfUpdateEnabled: true, isAdmin: true }),
    ).toBe(false);
  });

  it("requires ALL THREE conditions — any single one off hides the action", () => {
    // The full off-matrix: only (true,true,available) is present; every other
    // combination is absent. A regression that OR'd the gates (showing on any one)
    // would fail here — it is not a tautology.
    const cases: Array<{
      view: UpdateBannerView | null;
      selfUpdateEnabled: boolean;
      isAdmin: boolean;
      expected: boolean;
    }> = [
      { view: VIEW, selfUpdateEnabled: true, isAdmin: true, expected: true },
      { view: VIEW, selfUpdateEnabled: true, isAdmin: false, expected: false },
      { view: VIEW, selfUpdateEnabled: false, isAdmin: true, expected: false },
      { view: VIEW, selfUpdateEnabled: false, isAdmin: false, expected: false },
      { view: null, selfUpdateEnabled: true, isAdmin: true, expected: false },
      { view: null, selfUpdateEnabled: false, isAdmin: false, expected: false },
    ];
    for (const c of cases) {
      expect(
        selectUpgradeAction(c.view, {
          selfUpdateEnabled: c.selfUpdateEnabled,
          isAdmin: c.isAdmin,
        }),
      ).toBe(c.expected);
    }
  });
});
