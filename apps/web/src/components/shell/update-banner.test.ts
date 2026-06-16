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
import type { UpdateStatus } from "@cap/contracts";

import { selectBannerView } from "./update-banner";

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
