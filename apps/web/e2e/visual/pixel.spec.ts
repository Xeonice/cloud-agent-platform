/**
 * Per-page pixel gate (console-design-pixel-merge tasks 8.2/8.3).
 *
 * The `console` Playwright project: renders every merged console page in MOCK
 * DATA MODE (`VITE_FORCE_MOCK=1` — fixed typed fixtures, no live backend) at
 * desktop + the recorded ≤820px mobile breakpoint and asserts
 * `toHaveScreenshot()` against the living design baseline the dependency
 * project just captured (baseline.capture.ts), under the page's RECORDED
 * blocking `maxDiffPixelRatio` from the manifest. Exceeding the threshold
 * FAILS the suite — this is the change's required verify gate, not a warning.
 *
 * Determinism (task 8.3): mock fixtures are constant; relative timestamps are
 * fixed offsets (always render the same strings); `reducedMotion: "reduce"`
 * freezes the runner-capsule on its static branch (masked as well); the
 * session terminal + connection pill are masked (no socket exists in mock
 * mode); animations are disabled and the caret hidden at capture. Two runs
 * against the same build therefore produce identical per-page pass/fail
 * results — proven by running the suite twice back-to-back.
 */
import { expect, test } from "@playwright/test";

import { BREAKPOINTS, PAGES, snapshotName } from "./manifest";

/**
 * Seed the MOCK auth gate + persisted UI store exactly as a mock `login()`
 * leaves them (`lib/mock-session.ts`): the `_app` gate admits the operator and
 * `mockAuthSession` resolves the allowlisted identity. Runs before any page
 * script on every navigation in this context.
 */
const SEED_MOCK_SESSION = `
  window.sessionStorage.setItem("agent-control-plane-session", "1");
  window.localStorage.setItem(
    "agent-control-plane-state",
    JSON.stringify({
      githubConnected: true,
      importedRepos: [],
      selectedRepo: null,
      settings: {
        defaultRepoId: null,
        retention: 30,
        writeConfirm: true,
        maxConcurrentTasks: 5,
      },
      codexCredential: {
        mode: "official",
        state: "not_connected",
        hasApiKey: false,
      },
    }),
  );
`;

for (const breakpoint of BREAKPOINTS) {
  for (const visualPage of PAGES) {
    test(`${visualPage.id} @ ${breakpoint.id}`, async ({ page }) => {
      if (visualPage.authed) {
        await page.addInitScript(SEED_MOCK_SESSION);
      }
      await page.setViewportSize({
        width: breakpoint.width,
        height: breakpoint.height,
      });
      await page.goto(visualPage.appPath, { waitUntil: "load" });
      // Mock mode does no HTTP data fetching; networkidle here just waits out
      // dev-server module loading. Best-effort — polling never blocks it.
      await page
        .waitForLoadState("networkidle", { timeout: 15_000 })
        .catch(() => {});
      if (visualPage.readySelector) {
        await page
          .locator(visualPage.readySelector)
          .first()
          .waitFor({ state: "visible", timeout: 20_000 });
      }
      // Web fonts + a settle window for the mock fixtures (delay ≤ 420ms).
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(800);

      await expect(page).toHaveScreenshot(
        snapshotName(visualPage.id, breakpoint.id),
        {
          // The RECORDED blocking threshold for this page × breakpoint.
          maxDiffPixelRatio: visualPage.maxDiffPixelRatio[breakpoint.id],
          mask: (visualPage.appMask ?? []).map((selector) =>
            page.locator(selector),
          ),
        },
      );
    });
  }
}
