/**
 * Terminal story verification.
 *
 * This suite is deliberately separate from `playwright.config.ts`: the visual
 * baseline masks live terminal content, while these checks inspect xterm
 * geometry, scrollback, UTF-8 rendering, and resize behavior directly.
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
