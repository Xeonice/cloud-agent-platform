/**
 * Terminal story verification.
 *
 * This suite is deliberately separate from `playwright.config.ts`: the visual
 * baseline masks live terminal content, while these checks inspect xterm
 * geometry, scrollback, UTF-8 rendering, and resize behavior directly.
 *
 * ── Pinned rendering environment (close-gate-blindspots-and-ci-hygiene 7.1) ──
 * In CI this suite runs inside the SAME pinned Playwright Docker image as the
 * visual lane (in its own distinct lane, per the deliberately separate config):
 *
 *   mcr.microsoft.com/playwright:v1.60.0-noble
 *
 * The image tag version MUST equal the resolved `@playwright/test` version in
 * `pnpm-lock.yaml` (currently 1.60.0) — bump the two together. See
 * `e2e/visual-baseline-regeneration.md` for the pin's regeneration procedure.
 */
import { defineConfig } from "@playwright/test";

const STORY_PORT = 4327;

export default defineConfig({
  testDir: "./e2e/terminal-stories",
  testMatch: /terminal-stories\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 60_000,
  reporter: [["list"]],
  outputDir: "./e2e/test-results/terminal-stories",
  use: {
    browserName: "chromium",
    headless: true,
    deviceScaleFactor: 1,
    contextOptions: { reducedMotion: "reduce" },
    colorScheme: "light",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    baseURL: `http://127.0.0.1:${STORY_PORT}`,
  },
  webServer: {
    command: `pnpm terminal-stories:dev --host 127.0.0.1 --port ${STORY_PORT} --strictPort`,
    url: `http://127.0.0.1:${STORY_PORT}/?story=bare`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
