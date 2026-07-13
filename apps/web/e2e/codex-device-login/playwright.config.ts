import { defineConfig } from "@playwright/test";

const STORY_PORT = 4331;

export default defineConfig({
  testDir: ".",
  testMatch: /codex-device-login\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 60_000,
  reporter: [["list"]],
  outputDir: "../test-results/codex-device-login",
  expect: { timeout: 10_000 },
  use: {
    browserName: "chromium",
    headless: true,
    deviceScaleFactor: 1,
    contextOptions: { reducedMotion: "reduce" },
    colorScheme: "light",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    baseURL: `http://localhost:${STORY_PORT}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `pnpm codex-device-login:dev --host 0.0.0.0 --port ${STORY_PORT} --strictPort`,
    url: `http://localhost:${STORY_PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
