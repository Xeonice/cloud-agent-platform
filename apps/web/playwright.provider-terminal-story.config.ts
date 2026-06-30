/**
 * Opt-in provider-backed terminal story verification.
 *
 * This is separate from the masked visual suite and from the pure xterm story
 * suite because live provider checks allocate sandbox resources and require a
 * running, authenticated CAP API.
 */
import { defineConfig } from "@playwright/test";

const STORY_PORT = 4328;

export default defineConfig({
  testDir: "./e2e/provider-terminal-story",
  testMatch: /provider-terminal-story\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 90_000,
  reporter: [["list"]],
  outputDir: "./e2e/test-results/provider-terminal-story",
  use: {
    browserName: "chromium",
    headless: true,
    deviceScaleFactor: 1,
    colorScheme: "light",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    baseURL: `http://127.0.0.1:${STORY_PORT}`,
  },
  webServer: {
    command: `pnpm provider-terminal-story:dev --host 127.0.0.1 --port ${STORY_PORT} --strictPort`,
    url: `http://127.0.0.1:${STORY_PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
