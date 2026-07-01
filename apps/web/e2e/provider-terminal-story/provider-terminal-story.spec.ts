import { expect, test, type Page } from "@playwright/test";

interface StoryProbe {
  readonly status: string;
  readonly providerId: string | null;
  readonly sessionId: string | null;
  readonly readiness: {
    readonly enabled: boolean;
    readonly ready: boolean;
    readonly reason: string | null;
  } | null;
  readonly teardownStatus: string | null;
  readonly terminalText: string;
  readonly scrollTop: number | null;
  readonly scrollHeight: number | null;
  readonly clientHeight: number | null;
  readonly compact: boolean;
  readonly mountKey: number;
  readonly fixtureKind: string | null;
  readonly descriptor: {
    readonly terminalProtocol: string;
    readonly commandProtocol: string;
    readonly workspaceMode: string;
    readonly retentionMode: string;
  } | null;
  readonly error: string | null;
}

const LIVE_ENABLED = process.env.CAP_PROVIDER_TERMINAL_STORY_E2E === "1";
const LIVE_PROVIDER = process.env.CAP_PROVIDER_TERMINAL_STORY_PROVIDER ?? "auto";
const LIVE_API =
  process.env.VITE_API_BASE_URL ?? process.env.CAP_PUBLIC_API_BASE_URL ?? null;
const LIVE_TOKEN = process.env.VITE_AUTH_TOKEN ?? null;

async function readProbe(page: Page): Promise<StoryProbe> {
  const text = await page.locator('[data-testid="provider-story-probe"]').textContent();
  if (!text) throw new Error("missing provider story probe");
  return JSON.parse(text) as StoryProbe;
}

async function mockReadiness(page: Page, body: unknown): Promise<void> {
  await page.route("**/terminal-stories/provider?**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    }),
  );
}

test("not-enabled state is visible and does not leak provider internals", async ({
  page,
}) => {
  await mockReadiness(page, {
    enabled: false,
    ready: false,
    requestedProvider: "boxlite",
    configuredProvider: "aio",
    providerId: null,
    reason: "CAP_PROVIDER_TERMINAL_STORY=1 is required",
    capabilities: ["terminal.websocket"],
  });
  await page.route("**/terminal-stories/provider/sessions", (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ message: "CAP_PROVIDER_TERMINAL_STORY=1 is required" }),
    }),
  );

  await page.goto("/?provider=boxlite", { waitUntil: "load" });
  await expect(page.locator('[data-testid="provider-story-readiness"]')).toHaveText(
    "not-enabled",
  );
  await page.locator('[data-testid="provider-story-create"]').click();
  await expect(page.locator('[data-testid="provider-story-error"]')).toContainText(
    "HTTP 403",
  );
  await expect(page.locator("body")).not.toContainText("BOXLITE_API_TOKEN");
  await expect(page.locator("body")).not.toContainText("terminalUrl");
});

test("provider-readiness failure is visible before any live terminal mounts", async ({
  page,
}) => {
  await mockReadiness(page, {
    enabled: true,
    ready: false,
    requestedProvider: "boxlite",
    configuredProvider: "boxlite",
    providerId: "boxlite",
    reason: "BoxLite interactive terminal capability is required",
    capabilities: ["terminal.websocket"],
  });
  await page.route("**/terminal-stories/provider/sessions", (route) =>
    route.fulfill({
      status: 412,
      contentType: "application/json",
      body: JSON.stringify({
        message: "BoxLite interactive terminal capability is required",
      }),
    }),
  );

  await page.goto("/?provider=boxlite", { waitUntil: "load" });
  await expect(page.locator('[data-testid="provider-story-readiness"]')).toHaveText(
    "not-ready",
  );
  await expect(
    page.locator('[data-testid="provider-story-readiness-reason"]'),
  ).toContainText("interactive terminal");
  await expect(page.locator('[data-testid="provider-story-empty"]')).toBeVisible();
});

test("session projection contains only CAP story fields", async ({ page }) => {
  await mockReadiness(page, {
    enabled: true,
    ready: true,
    requestedProvider: "boxlite",
    configuredProvider: "boxlite",
    providerId: "boxlite",
    reason: null,
    capabilities: ["terminal.websocket", "terminal.interactive"],
  });
  await page.route("**/terminal-stories/provider/sessions", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: "terminal-story-public-only",
        status: "running",
        providerId: "boxlite",
        requestedProvider: "boxlite",
        createdAt: "2026-06-30T00:00:00.000Z",
        expiresAt: "2026-06-30T00:10:00.000Z",
        terminalPath: "/terminal",
      }),
    }),
  );

  await page.goto("/?provider=boxlite", { waitUntil: "load" });
  await page.locator('[data-testid="provider-story-create"]').click();
  await expect(page.locator('[data-testid="provider-story-session-id"]')).toHaveText(
    "terminal-story-public-only",
  );
  await expect(page.locator("body")).not.toContainText("https://boxlite.example");
  await expect(page.locator("body")).not.toContainText("Bearer");
  await expect(page.locator("body")).not.toContainText("sandboxId");
});

const PROVIDER_FIXTURES = {
  aio: {
    sessionId: "provider-fixture-aio-session",
    terminalProtocol: "aio-json-v1",
    commandProtocol: "aio-http-exec-v1",
    workspaceMode: "git",
    retentionMode: "stop-retain",
    snapshot: "PROVIDER_FIXTURE_AIO_SNAPSHOT_BEGIN",
    tail: "PROVIDER_FIXTURE_AIO_TAIL_REPLAY_BEGIN",
    live: "PROVIDER_FIXTURE_AIO_LIVE_002",
    leaks: [
      "aio-private-sandbox-id",
      "cap-aio-private-fixture",
      "http://cap-aio-private-fixture:8080",
      "AIO_SANDBOX_IMAGE",
    ],
  },
  boxlite: {
    sessionId: "provider-fixture-boxlite-session",
    terminalProtocol: "boxlite-v1",
    commandProtocol: "boxlite-exec-v1",
    workspaceMode: "archive",
    retentionMode: "provider-native",
    snapshot: "PROVIDER_FIXTURE_BOXLITE_SNAPSHOT_BEGIN",
    tail: "PROVIDER_FIXTURE_BOXLITE_TAIL_REPLAY_BEGIN",
    live: "PROVIDER_FIXTURE_BOXLITE_LIVE_002",
    leaks: [
      "boxlite-private-sandbox-id",
      "boxlite-private.fixture.invalid",
      "https://boxlite-private.fixture.invalid/v1/boxes/private",
      "BOXLITE_API_TOKEN",
    ],
  },
} as const;

for (const [fixture, expected] of Object.entries(PROVIDER_FIXTURES)) {
  test(`fixture ${fixture} renders SessionTerminal reconnect flow without backend`, async ({
    page,
  }) => {
    await page.goto(`/?fixture=${fixture}&autostart=1`, { waitUntil: "load" });

    await expect
      .poll(async () => (await readProbe(page)).sessionId, { timeout: 15_000 })
      .toBe(expected.sessionId);
    await expect
      .poll(async () => (await readProbe(page)).fixtureKind, { timeout: 15_000 })
      .toBe(fixture);

    await expect
      .poll(async () => (await readProbe(page)).descriptor, { timeout: 15_000 })
      .toEqual({
        terminalProtocol: expected.terminalProtocol,
        commandProtocol: expected.commandProtocol,
        workspaceMode: expected.workspaceMode,
        retentionMode: expected.retentionMode,
      });

    await expect
      .poll(async () => (await readProbe(page)).terminalText, { timeout: 30_000 })
      .toContain("PROVIDER_FIXTURE_TAIL_FINAL");
    await expect
      .poll(async () => (await readProbe(page)).terminalText, { timeout: 30_000 })
      .toContain(expected.live);

    await page.locator('[data-testid="provider-story-scroll-top"]').click();
    await expect
      .poll(async () => (await readProbe(page)).terminalText, { timeout: 15_000 })
      .toContain(expected.snapshot);
    await expect
      .poll(async () => (await readProbe(page)).terminalText, { timeout: 15_000 })
      .toContain(expected.tail);
    await page.locator('[data-testid="provider-story-scroll-bottom"]').click();

    await page.locator(".xterm").click();
    await page.keyboard.type(`fixture-${fixture}`);
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => (await readProbe(page)).terminalText, { timeout: 15_000 })
      .toContain(`PROVIDER_FIXTURE_ECHO:fixture-${fixture}`);

    await page.locator('[data-testid="provider-story-toggle-size"]').click();
    await expect
      .poll(async () => (await readProbe(page)).terminalText, { timeout: 15_000 })
      .toMatch(/PROVIDER_FIXTURE_RESIZE:\d+x\d+/);

    const beforeReconnect = await readProbe(page);
    await page.locator('[data-testid="provider-story-reconnect"]').click();
    await expect
      .poll(async () => (await readProbe(page)).mountKey, { timeout: 15_000 })
      .toBeGreaterThan(beforeReconnect.mountKey);
    await expect
      .poll(async () => (await readProbe(page)).terminalText, { timeout: 30_000 })
      .toContain("PROVIDER_FIXTURE_TAIL_FINAL");

    for (const leak of expected.leaks) {
      await expect(page.locator("body")).not.toContainText(leak);
    }
  });
}

test.describe("live provider-backed story", () => {
  test.skip(
    !LIVE_ENABLED || !LIVE_API || !LIVE_TOKEN,
    "set CAP_PROVIDER_TERMINAL_STORY_E2E=1, VITE_API_BASE_URL, and VITE_AUTH_TOKEN to run live provider checks",
  );

  test("streams output, accepts input, resizes, scrolls, reconnects, and tears down", async ({
    page,
  }) => {
    await page.goto(`/?provider=${encodeURIComponent(LIVE_PROVIDER)}&autostart=1`, {
      waitUntil: "load",
    });

    await expect
      .poll(async () => (await readProbe(page)).sessionId, { timeout: 60_000 })
      .toMatch(/^terminal-story-/);
    await expect
      .poll(async () => (await readProbe(page)).terminalText, { timeout: 60_000 })
      .toMatch(/PROVIDER_STORY_(READY_FOR_INPUT|LIVE_\d+)/);

    await page.locator('[data-testid="provider-story-scroll-top"]').click();
    await expect
      .poll(async () => (await readProbe(page)).terminalText, { timeout: 15_000 })
      .toContain("PROVIDER_STORY_BEGIN");
    await expect
      .poll(async () => (await readProbe(page)).terminalText, { timeout: 15_000 })
      .toContain("中文渲染正常");
    await page.locator('[data-testid="provider-story-scroll-bottom"]').click();

    await page.locator(".xterm").click();
    await page.keyboard.type("hello-from-playwright");
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => (await readProbe(page)).terminalText, { timeout: 30_000 })
      .toContain("PROVIDER_STORY_ECHO:hello-from-playwright");

    await page.locator('[data-testid="provider-story-toggle-size"]').click();
    await expect
      .poll(async () => (await readProbe(page)).terminalText, { timeout: 30_000 })
      .toMatch(/PROVIDER_STORY_RESIZE:\d+x\d+/);

    await page.locator('[data-testid="provider-story-scroll-top"]').click();
    await expect
      .poll(async () => (await readProbe(page)).terminalText, { timeout: 15_000 })
      .toContain("PROVIDER_STORY_BEGIN");

    const beforeReconnect = await readProbe(page);
    await page.locator('[data-testid="provider-story-reconnect"]').click();
    await expect
      .poll(async () => (await readProbe(page)).mountKey, { timeout: 15_000 })
      .toBeGreaterThan(beforeReconnect.mountKey);
    await expect
      .poll(async () => (await readProbe(page)).terminalText, { timeout: 30_000 })
      .toMatch(/PROVIDER_STORY_RESIZE:\d+x\d+/);

    await page.locator('[data-testid="provider-story-teardown"]').click();
    await expect
      .poll(async () => (await readProbe(page)).teardownStatus, { timeout: 30_000 })
      .toBe("torn_down");
  });
});
