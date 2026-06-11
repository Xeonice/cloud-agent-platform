/**
 * Playwright visual-verification config (console-design-pixel-merge Track 8 —
 * the change's REQUIRED verify gate, spec "Required per-page pixel comparison
 * against the design baselines").
 *
 * Run: `pnpm test:visual` (from apps/web). Two projects, strictly ordered:
 *
 *   1. `design-baseline` (baseline.capture.ts) — screenshots the design
 *      prototype (the LIVING baseline source,
 *      `openspec/changes/console-design-pixel-merge/design-baseline/`, served
 *      by webServer[0]) into `e2e/visual/__screenshots__/` (gitignored;
 *      regenerated every run — see e2e/visual/manifest.ts for the full
 *      baseline-source / regeneration / threshold-calibration procedure).
 *   2. `console` (pixel.spec.ts) — depends on (1); renders the app (webServer[1],
 *      dev server in MOCK DATA MODE via `VITE_FORCE_MOCK=1`) and compares each
 *      page × breakpoint with `toHaveScreenshot()` under the manifest's
 *      recorded blocking thresholds.
 *
 * Determinism posture (task 8.3): single worker, no retries, fixed viewports,
 * `deviceScaleFactor: 1`, `reducedMotion: "reduce"` (freezes the
 * runner-capsule's loop on its static branch on BOTH sides), animations
 * disabled + caret hidden at capture, fixed mock fixtures, dynamic regions
 * (session terminal, connection pill, runner-capsule) masked identically on
 * both sides. `VITE_WS_URL` is blanked so the session socket resolves to the
 * PERMANENT config-error state (stable pill) instead of a reconnect loop —
 * regardless of whether a local api happens to be running.
 */
import { defineConfig } from "@playwright/test";

const DESIGN_PORT = 4317;
const APP_PORT = 3217;

export default defineConfig({
  testDir: "./e2e/visual",
  // Determinism: serial, one browser, no retry masking of flakiness.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 60_000,
  reporter: [["list"]],
  outputDir: "./e2e/test-results",
  // One flat, platform-independent snapshot path shared by the capture and
  // comparison projects: e2e/visual/__screenshots__/<page>-<breakpoint>.png
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
  expect: {
    timeout: 15_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
    },
  },
  use: {
    browserName: "chromium",
    headless: true,
    deviceScaleFactor: 1,
    contextOptions: { reducedMotion: "reduce" },
    colorScheme: "light",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    // `localhost`, not 127.0.0.1: vite dev may bind IPv6-only (`::1`).
    baseURL: `http://localhost:${APP_PORT}`,
  },
  projects: [
    {
      name: "design-baseline",
      testMatch: /baseline\.capture\.ts/,
    },
    {
      name: "console",
      testMatch: /pixel\.spec\.ts/,
      dependencies: ["design-baseline"],
    },
  ],
  webServer: [
    {
      // The design prototype — the living baseline source (design.md D7).
      command: `node e2e/serve-design-baseline.mjs ${DESIGN_PORT}`,
      url: `http://localhost:${DESIGN_PORT}/index.html`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // The app under test, in deterministic MOCK DATA MODE. `VITE_WS_URL` /
      // `VITE_API_BASE_URL` are blanked (empty beats .env in Vite) so no run
      // ever touches a live backend.
      command: `pnpm dev --port ${APP_PORT} --strictPort`,
      url: `http://localhost:${APP_PORT}/`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        VITE_FORCE_MOCK: "1",
        VITE_API_BASE_URL: "",
        VITE_WS_URL: "",
        VITE_AUTH_TOKEN: "",
      },
    },
  ],
});
