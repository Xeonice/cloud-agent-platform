import { networkInterfaces } from "node:os";
import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Route,
} from "@playwright/test";

const STORY_PORT = 4331;
const LOCAL_ORIGIN = `http://localhost:${STORY_PORT}`;
const EXPIRES_AT = "2026-07-13T12:00:00.000Z";
const FIRST_SESSION = "00000000-0000-4000-8000-000000000701";
const SECOND_SESSION = "00000000-0000-4000-8000-000000000702";
const DEVICE_CODE = "ABCD-1234";
const SECOND_DEVICE_CODE = "WXYZ-9876";
const VERIFICATION_URI = "https://auth.openai.test/codex/device";
const browserErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "browser console/page errors").toEqual([]);
});

function findNonLoopbackHost(): string {
  const configured = process.env.CAP_E2E_NON_LOOPBACK_HOST?.trim();
  if (configured) return configured;

  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  throw new Error(
    "No non-loopback IPv4 address is available; set CAP_E2E_NON_LOOPBACK_HOST.",
  );
}

const NON_LOOPBACK_ORIGIN = `http://${findNonLoopbackHost()}:${STORY_PORT}`;

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  });
}

function startBody(sessionId: string) {
  return { sessionId, status: "preparing", expiresAt: EXPIRES_AT } as const;
}

function awaitingBody(sessionId: string, userCode = DEVICE_CODE) {
  return {
    sessionId,
    status: "awaiting_authorization",
    expiresAt: EXPIRES_AT,
    verificationUri: VERIFICATION_URI,
    userCode,
  } as const;
}

async function installImmediateAwaitingApi(
  page: Page,
  sessionId = FIRST_SESSION,
  userCode = DEVICE_CODE,
): Promise<string[]> {
  const deleted: string[] = [];
  await page.route("**/settings/codex/device-login**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST") {
      await json(route, startBody(sessionId), 202);
      return;
    }
    const requestedSession = pathname.split("/").at(-1) ?? "";
    if (request.method() === "GET") {
      await json(route, awaitingBody(requestedSession, userCode));
      return;
    }
    if (request.method() === "DELETE") {
      deleted.push(requestedSession);
      await route.fulfill({ status: 204 });
      return;
    }
    await route.abort();
  });
  return deleted;
}

async function openAwaitingDialog(page: Page, origin: string): Promise<void> {
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "连接官方账号", exact: true }).click();
  await expect(page.locator("[data-device-code]")).toHaveText(DEVICE_CODE);
}

async function assertNoFrameworkError(page: Page): Promise<void> {
  await expect(
    page.locator(
      "vite-error-overlay, .vite-error-overlay, [data-nextjs-dialog], #webpack-dev-server-client-overlay",
    ),
  ).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveText("");
}

async function installAuthorizationPage(context: BrowserContext): Promise<void> {
  await context.route(`${VERIFICATION_URI}**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>OpenAI authorization fixture</title><h1>authorization</h1>",
    });
  });
}

test("localhost keeps preparation in-dialog, opens only the safe authorization action, and copies with the modern API", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: LOCAL_ORIGIN,
  });
  await installAuthorizationPage(context);

  let releaseStart!: () => void;
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  await page.route("**/settings/codex/device-login**", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      await startGate;
      await json(route, startBody(FIRST_SESSION), 202);
      return;
    }
    if (request.method() === "GET") {
      await json(route, awaitingBody(FIRST_SESSION));
      return;
    }
    await route.fulfill({ status: 204 });
  });

  await page.goto(LOCAL_ORIGIN, { waitUntil: "networkidle" });
  expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
  const pageCountBeforeStart = context.pages().length;
  await page.getByRole("button", { name: "连接官方账号", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("正在准备设备码");
  expect(context.pages()).toHaveLength(pageCountBeforeStart);
  expect(context.pages().some((candidate) => candidate.url() === "about:blank")).toBe(
    false,
  );

  releaseStart();
  const link = page.getByRole("link", { name: "前往 OpenAI 授权" });
  await expect(link).toHaveAttribute("href", VERIFICATION_URI);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /\bnoopener\b/);
  await expect(link).toHaveAttribute("rel", /\bnoreferrer\b/);
  await expect(link).toHaveAttribute("referrerpolicy", "no-referrer");

  const [authorizationPage] = await Promise.all([
    page.waitForEvent("popup"),
    link.click(),
  ]);
  await authorizationPage.waitForLoadState("domcontentloaded");
  expect(authorizationPage.url()).toBe(VERIFICATION_URI);
  expect(await authorizationPage.evaluate(() => window.opener === null)).toBe(true);
  expect(await authorizationPage.evaluate(() => document.referrer)).toBe("");
  await authorizationPage.close();
  await page.bringToFront();

  await page.getByRole("button", { name: "复制设备码" }).click();
  await expect(page.getByRole("button", { name: "已复制" })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(DEVICE_CODE);
  await assertNoFrameworkError(page);
});

test("non-loopback HTTP uses the real compatibility copy path", async ({ page }) => {
  await installImmediateAwaitingApi(page);
  await openAwaitingDialog(page, NON_LOOPBACK_ORIGIN);

  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  expect(await page.evaluate(() => typeof navigator.clipboard)).toBe("undefined");
  await page.getByRole("button", { name: "复制设备码" }).click();
  await expect(page.getByRole("button", { name: "已复制" })).toBeVisible();

  await page.evaluate(() => {
    const input = document.createElement("input");
    input.setAttribute("data-paste-probe", "");
    document.querySelector('[data-slot="dialog-content"]')?.appendChild(input);
  });
  const pasteProbe = page.locator("[data-paste-probe]");
  await pasteProbe.focus();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
  await expect(pasteProbe).toHaveValue(DEVICE_CODE);
  await assertNoFrameworkError(page);
});

test("non-loopback HTTP exposes manual-copy guidance and selects the code when compatibility copy fails", async ({
  page,
}) => {
  await installImmediateAwaitingApi(page);
  await page.goto(NON_LOOPBACK_ORIGIN, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: () => false,
    });
  });
  await page.getByRole("button", { name: "连接官方账号", exact: true }).click();
  await expect(page.locator("[data-device-code]")).toHaveText(DEVICE_CODE);

  await page.getByRole("button", { name: "复制设备码" }).click();
  await expect(page.getByRole("alert")).toContainText("Ctrl+C / Command+C");
  expect(
    await page.evaluate(() => document.activeElement?.hasAttribute("data-device-code")),
  ).toBe(true);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
    DEVICE_CODE,
  );
  await assertNoFrameworkError(page);
});

test("closing during preparation cancels the late exact session and stale POST completion cannot revive old UI", async ({
  page,
}) => {
  const pendingStarts: Route[] = [];
  const deleted: string[] = [];
  const getSessions: string[] = [];
  await page.route("**/settings/codex/device-login**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const sessionId = pathname.split("/").at(-1) ?? "";
    if (request.method() === "POST") {
      pendingStarts.push(route);
      return;
    }
    if (request.method() === "GET") {
      getSessions.push(sessionId);
      await json(
        route,
        awaitingBody(
          sessionId,
          sessionId === SECOND_SESSION ? SECOND_DEVICE_CODE : DEVICE_CODE,
        ),
      );
      return;
    }
    if (request.method() === "DELETE") {
      deleted.push(sessionId);
      await route.fulfill({ status: 204 });
      return;
    }
    await route.abort();
  });

  await page.goto(LOCAL_ORIGIN, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "连接官方账号", exact: true }).click();
  await expect.poll(() => pendingStarts.length).toBe(1);
  await expect(page.getByRole("status")).toContainText("正在准备设备码");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByRole("button", { name: "打开官方账号对话框" }).click();
  await page.getByRole("button", { name: "连接官方账号", exact: true }).click();
  await expect.poll(() => pendingStarts.length).toBe(2);
  await json(pendingStarts[1]!, startBody(SECOND_SESSION), 202);
  await expect(page.locator("[data-device-code]")).toHaveText(SECOND_DEVICE_CODE);

  await json(pendingStarts[0]!, startBody(FIRST_SESSION), 202);
  await expect.poll(() => deleted).toContain(FIRST_SESSION);
  await expect(page.locator("[data-device-code]")).toHaveText(SECOND_DEVICE_CODE);
  await expect(page.getByText(DEVICE_CODE, { exact: true })).toHaveCount(0);
  expect(getSessions).not.toContain(FIRST_SESSION);

  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect.poll(() => deleted).toContain(SECOND_SESSION);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await assertNoFrameworkError(page);
});

test("the production dialog keeps its fixed-width and height-capped scrolling shell", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 500 });
  await installImmediateAwaitingApi(page);
  await openAwaitingDialog(page, LOCAL_ORIGIN);

  const dialog = page.getByRole("dialog");
  const labelledBy = await dialog.getAttribute("aria-labelledby");
  expect(labelledBy).toBeTruthy();
  expect(
    await page.evaluate(
      (id) => document.getElementById(id)?.textContent?.trim(),
      labelledBy!,
    ),
  ).toBe("连接官方 Codex 账号");
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(700);
  expect(box!.width).toBeLessThanOrEqual(721);
  expect(box!.height).toBeLessThanOrEqual(500 * 0.85 + 1);

  const bodyMetrics = await page.locator('[data-slot="dialog-body"]').evaluate(
    (element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
    }),
  );
  expect(bodyMetrics.overflowY).toBe("auto");
  expect(bodyMetrics.scrollHeight).toBeGreaterThan(bodyMetrics.clientHeight);
  await expect(page.getByRole("button", { name: "取消", exact: true })).toBeVisible();
  await assertNoFrameworkError(page);
});
