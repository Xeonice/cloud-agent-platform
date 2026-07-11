import { defineConfig } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function requiredUrl(name: "E2E_API_URL" | "E2E_WEB_URL" | "E2E_CONTROL_URL"): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the isolated scheduled-task E2E`);
  }
  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
}

const webUrl = requiredUrl("E2E_WEB_URL");
requiredUrl("E2E_API_URL");
requiredUrl("E2E_CONTROL_URL");

const configuredArtifactRoot = process.env.E2E_ARTIFACT_DIR?.trim();
if (!configuredArtifactRoot) {
  throw new Error(
    "E2E_ARTIFACT_DIR is required so Playwright artifacts stay outside the source tree",
  );
}
const artifactRoot = resolve(configuredArtifactRoot);

export default defineConfig({
  testDir: here,
  testMatch: /scheduled-tasks\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 90_000,
  outputDir: resolve(artifactRoot, "test-output"),
  globalTeardown: resolve(
    here,
    "../../../../scripts/sanitize-scheduled-tasks-e2e-artifacts.mjs",
  ),
  reporter: [["list"]],
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: webUrl,
    browserName: "chromium",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
