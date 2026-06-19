/**
 * Living-baseline capture (console-design-pixel-merge task 8.1).
 *
 * The `design-baseline` Playwright project: renders every design prototype
 * page (served by `e2e/serve-design-baseline.mjs` from the stable
 * `apps/web/e2e/design-baseline/` source) at every
 * breakpoint and writes the screenshot to the EXACT snapshot path the
 * comparison project's `toHaveScreenshot()` resolves
 * (`e2e/visual/__screenshots__/<page>-<breakpoint>.png`, via the config's
 * `snapshotPathTemplate`). Because the comparison project depends on this one,
 * baselines are regenerated from the design source on EVERY run — they are
 * living baselines, not checked-in PNGs (design.md D7).
 *
 * Capture conditions are IDENTICAL to the app capture (same browser, viewport,
 * deviceScaleFactor 1, `reducedMotion: "reduce"`, animations disabled, caret
 * hidden, same masked regions) so the comparison carries no platform variance.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";

import { BREAKPOINTS, PAGES, snapshotName } from "./manifest";

const here = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = path.join(here, "__screenshots__");

const DESIGN_BASE_URL =
  process.env.VV_DESIGN_BASE_URL ?? "http://localhost:4317";

for (const breakpoint of BREAKPOINTS) {
  for (const visualPage of PAGES) {
    test(`baseline ${visualPage.id} @ ${breakpoint.id}`, async ({ page }) => {
      await page.setViewportSize({
        width: breakpoint.width,
        height: breakpoint.height,
      });
      await page.goto(`${DESIGN_BASE_URL}${visualPage.designPath}`, {
        waitUntil: "networkidle",
      });
      // Web fonts settled before capture (CJK fallback stability).
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(250);

      const screenshot = await page.screenshot({
        animations: "disabled",
        caret: "hide",
        mask: (visualPage.designMask ?? []).map((selector) =>
          page.locator(selector),
        ),
      });
      mkdirSync(SNAPSHOT_DIR, { recursive: true });
      writeFileSync(
        path.join(
          SNAPSHOT_DIR,
          snapshotName(visualPage.id, breakpoint.id),
        ),
        screenshot,
      );
    });
  }
}
