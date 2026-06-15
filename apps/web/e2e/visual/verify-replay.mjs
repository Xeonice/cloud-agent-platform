/**
 * One-off visual verification for the session replay page (session-sandbox-retention
 * task 8.6). NOT part of the suite — run manually against a mock dev server:
 *   VITE_FORCE_MOCK=1 pnpm dev --port 4317 --strictPort &
 *   node e2e/visual/verify-replay.mjs
 *
 * Captures the app's replay (completed mock task) + the design baseline, and
 * asserts a RUNNING task still mounts the live terminal (the live path is
 * untouched). Writes PNGs to /tmp for side-by-side inspection.
 */
import { chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.APP_URL || "http://localhost:4317";
const BASELINE =
  "file://" +
  path.resolve(
    here,
    "../../../../openspec/changes/session-sandbox-retention/design-baseline/history-replay-preview.html",
  );
const COMPLETED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // mock task c (completed)
const RUNNING = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // mock task a (running)

const SEED = `
  window.sessionStorage.setItem("agent-control-plane-session", "1");
  window.localStorage.setItem("agent-control-plane-state", JSON.stringify({
    githubConnected: true, importedRepos: [], selectedRepo: null,
    settings: { defaultRepoId: null, retention: 30, writeConfirm: true, maxConcurrentTasks: 5 },
    codexCredential: { mode: "official", state: "not_connected", hasApiKey: false },
  }));
`;

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
await ctx.addInitScript(SEED);
const page = await ctx.newPage();
const results = {};

// 1) App replay (completed task) — the conversation transcript.
await page.goto(`${APP}/tasks/${COMPLETED}`, { waitUntil: "load" });
await page
  .getByText("最终回答", { exact: false })
  .first()
  .waitFor({ timeout: 20_000 })
  .catch(() => {});
results.replayFinalAnswer = await page
  .getByText("最终回答")
  .first()
  .isVisible()
  .catch(() => false);
results.replayToolCard = await page
  .getByText("exec_command")
  .first()
  .isVisible()
  .catch(() => false);
results.replayHasLiveTerminal = await page
  .locator("article.bg-terminal-bg")
  .first()
  .isVisible()
  .catch(() => false);
await page.screenshot({ path: "/tmp/app-replay.png", fullPage: false });

// 2) Filter check: 用户 hides tool cards.
await page.getByRole("button", { name: "用户" }).first().click().catch(() => {});
await page.waitForTimeout(200);
results.userFilterHidesTools = !(await page
  .getByText("exec_command")
  .first()
  .isVisible()
  .catch(() => false));

// 3) Running task still mounts the live terminal (NOT the replay).
await page.goto(`${APP}/tasks/${RUNNING}`, { waitUntil: "load" });
await page
  .locator("article.bg-terminal-bg")
  .first()
  .waitFor({ timeout: 20_000 })
  .catch(() => {});
results.runningMountsTerminal = await page
  .locator("article.bg-terminal-bg")
  .first()
  .isVisible()
  .catch(() => false);

// 4) Design baseline screenshot for side-by-side comparison.
await page.goto(BASELINE, { waitUntil: "load" });
await page.screenshot({ path: "/tmp/baseline-replay.png", fullPage: false });

await browser.close();
console.log(JSON.stringify(results, null, 2));
