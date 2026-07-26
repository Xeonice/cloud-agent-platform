import { expect, test, type Page } from "@playwright/test";
import {
  TERMINAL_PROTOCOL_VERSION,
  XTERM_5_5_0_RESPONSE_PROFILE_ID,
} from "@cap/contracts";

interface StoryProbe {
  readonly mode: "managed" | "fixture" | "external";
  readonly external: boolean;
  readonly status: string;
  readonly providerId: string | null;
  readonly sessionId: string | null;
  readonly readiness: {
    readonly enabled: boolean;
    readonly ready: boolean;
    readonly reason: string | null;
  } | null;
  readonly teardownStatus: string | null;
  readonly teardownError: string | null;
  readonly cleanupEvidence: {
    readonly gatewayOwnerReleased: boolean;
    readonly gatewayViewersReleased: boolean;
    readonly providerAbsent: boolean;
    readonly backingRepoRemoved: boolean;
    readonly telemetryObserverReleased: boolean;
  } | null;
  readonly inventory: {
    readonly sessionId: string;
    readonly events: ReadonlyArray<{
      readonly sequence: number;
      readonly event: Readonly<Record<string, unknown>>;
    }>;
    readonly truncated: boolean;
    readonly gateway: {
      readonly ownerRegistered: boolean;
      readonly activeViewerCount: number;
    };
  } | null;
  readonly terminalText: string;
  readonly canonicalScreen: string;
  readonly terminalGeometry: { readonly cols: number; readonly rows: number } | null;
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

type ProviderFixtureWindow = Window &
  typeof globalThis & {
    __capProviderFixtureAttachFrames?: Array<Record<string, unknown>>;
    __capProviderFixtureConnectionOrigins?: number[];
    __capProviderFixtureAckSeqs?: number[];
    __capProviderFixtureResponses?: number[][];
    __capProviderFixtureQueries?: Array<{
      readonly name: string;
      readonly bytes: number[];
    }>;
    __capProviderFixtureProviderWrites?: Array<{
      readonly type: "keystroke" | "terminal_response";
      readonly bytes: number[];
    }>;
    __capProviderFixtureCloseOpenSockets?: (code?: number) => void;
    __capProviderFixtureEmitRaw?: (text: string) => void;
  };

const LIVE_ENABLED = process.env.CAP_PROVIDER_TERMINAL_STORY_E2E === "1";
type LiveProvider = "auto" | "aio" | "boxlite";
function configuredLiveProvider(): LiveProvider {
  const raw = process.env.CAP_PROVIDER_TERMINAL_STORY_PROVIDER ?? "auto";
  if (raw === "auto" || raw === "aio" || raw === "boxlite") return raw;
  if (LIVE_ENABLED) {
    throw new Error(
      "CAP_PROVIDER_TERMINAL_STORY_PROVIDER must be auto, aio, or boxlite",
    );
  }
  return "auto";
}
const LIVE_PROVIDER = configuredLiveProvider();
const LIVE_API =
  process.env.VITE_API_BASE_URL ?? process.env.CAP_PUBLIC_API_BASE_URL ?? null;
const LIVE_WS =
  process.env.VITE_WS_URL ??
  process.env.CAP_PUBLIC_WS_URL ??
  (LIVE_API ? LIVE_API.replace(/^http/, "ws") : null);
const LIVE_TOKEN = process.env.VITE_AUTH_TOKEN ?? null;

interface CapturedTerminalConnection {
  readonly origin: string;
  readonly pathname: string;
  readonly receivedRaw: Buffer[];
  readonly receivedControlTypes: string[];
  readonly sentControlTypes: string[];
  closed: boolean;
}

function observeCapTerminalConnections(
  page: Page,
): CapturedTerminalConnection[] {
  const connections: CapturedTerminalConnection[] = [];
  page.on("websocket", (socket) => {
    const url = new URL(socket.url());
    if (url.pathname !== "/terminal") return;
    const connection: CapturedTerminalConnection = {
      origin: url.origin,
      pathname: url.pathname,
      receivedRaw: [],
      receivedControlTypes: [],
      sentControlTypes: [],
      closed: false,
    };
    connections.push(connection);

    const observeFrame = (
      direction: "received" | "sent",
      payload: string | Buffer,
    ) => {
      const text =
        typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8");
      let frame: unknown;
      try {
        frame = JSON.parse(text);
      } catch {
        return;
      }
      if (!frame || typeof frame !== "object") return;
      const record = frame as Record<string, unknown>;
      if (
        direction === "received" &&
        record.channel === "raw" &&
        typeof record.data === "string"
      ) {
        connection.receivedRaw.push(Buffer.from(record.data, "base64"));
        return;
      }
      if (record.channel !== "control" || typeof record.type !== "string") return;
      (direction === "received"
        ? connection.receivedControlTypes
        : connection.sentControlTypes
      ).push(record.type);
    };

    socket.on("framereceived", ({ payload }) => observeFrame("received", payload));
    socket.on("framesent", ({ payload }) => observeFrame("sent", payload));
    socket.on("close", () => {
      connection.closed = true;
    });
  });
  return connections;
}

function receivedText(connection: CapturedTerminalConnection): string {
  return Buffer.concat(connection.receivedRaw).toString("utf8");
}

function occurrenceCount(value: string, marker: string): number {
  return value.split(marker).length - 1;
}

async function typeTerminalCommand(page: Page, command: string): Promise<void> {
  await page.locator(".xterm").click();
  await page.keyboard.insertText(command);
  await page.keyboard.press("Enter");
}

async function teardownFixture(page: Page): Promise<void> {
  await page.locator('[data-testid="provider-story-teardown"]').click();
  await expect
    .poll(async () => (await readProbe(page)).teardownStatus, { timeout: 10_000 })
    .toBe("torn_down");
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            !Object.hasOwn(window, "__capProviderFixtureAttachFrames") &&
            !Object.hasOwn(window, "__capProviderFixtureEmitRaw") &&
            window.WebSocket.name !== "FixtureWebSocket",
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
}

async function readProbe(page: Page): Promise<StoryProbe> {
  const text = await page.locator('[data-testid="provider-story-probe"]').textContent();
  if (!text) throw new Error("missing provider story probe");
  return JSON.parse(text) as StoryProbe;
}

async function expectTerminalRowsVisible(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const slot = document
            .querySelector('[data-testid="provider-story-terminal-slot"]')
            ?.getBoundingClientRect();
          const rows = document.querySelector(".xterm-rows")?.getBoundingClientRect();
          if (!slot || !rows) return "missing";
          const overlap =
            Math.min(slot.bottom, rows.bottom) - Math.max(slot.top, rows.top);
          const visible =
            rows.width > 0 &&
            rows.height > 0 &&
            overlap >= Math.min(24, rows.height);
          if (visible) return "visible";
          return JSON.stringify({
            slot: {
              top: Math.round(slot.top),
              bottom: Math.round(slot.bottom),
              height: Math.round(slot.height),
            },
            rows: {
              top: Math.round(rows.top),
              bottom: Math.round(rows.bottom),
              height: Math.round(rows.height),
            },
            overlap: Math.round(overlap),
          });
        }),
      { timeout: 15_000 },
    )
    .toBe("visible");
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

test("an invalid explicit provider fails locally before readiness or create", async ({
  page,
}) => {
  let readinessRequests = 0;
  let createRequests = 0;
  await page.route("**/terminal-stories/provider?**", (route) => {
    readinessRequests += 1;
    return route.fulfill({ status: 500, body: "unexpected readiness" });
  });
  await page.route("**/terminal-stories/provider/sessions", (route) => {
    createRequests += 1;
    return route.fulfill({ status: 500, body: "unexpected create" });
  });

  await page.goto("/?provider=boxltei&autostart=1", { waitUntil: "load" });
  await expect(page.locator('[data-testid="provider-story-readiness"]')).toHaveText(
    "invalid-provider",
  );
  await expect(page.locator('[data-testid="provider-story-error"]')).toContainText(
    "invalid provider selection",
  );
  await expect(page.locator('[data-testid="provider-story-create"]')).toBeDisabled();
  await expect(page.locator(".xterm")).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(readinessRequests).toBe(0);
  expect(createRequests).toBe(0);
});

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

test("teardown cleanup uncertainty is explicit instead of a successful story", async ({
  page,
}) => {
  await mockReadiness(page, {
    enabled: true,
    ready: true,
    requestedProvider: "aio",
    configuredProvider: "aio",
    providerId: "aio-local",
    reason: null,
    capabilities: ["terminal.websocket"],
  });
  await page.route("**/terminal-stories/provider/sessions", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: "terminal-story-cleanup-failure",
        status: "running",
        providerId: "aio-local",
        requestedProvider: "aio",
        createdAt: "2026-06-30T00:00:00.000Z",
        expiresAt: "2026-06-30T00:10:00.000Z",
        terminalPath: "/terminal",
      }),
    }),
  );
  await page.route(
    "**/terminal-stories/provider/sessions/terminal-story-cleanup-failure",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessionId: "terminal-story-cleanup-failure",
          status: "torn_down",
          providerId: "aio-local",
          requestedProvider: "aio",
          createdAt: "2026-06-30T00:00:00.000Z",
          expiresAt: "2026-06-30T00:10:00.000Z",
          terminalPath: "/terminal",
          teardownError: "provider cleanup failed",
        }),
      }),
  );

  await page.goto("/?provider=aio", { waitUntil: "load" });
  await page.locator('[data-testid="provider-story-create"]').click();
  await expect(page.locator('[data-testid="provider-story-session-id"]')).toHaveText(
    "terminal-story-cleanup-failure",
  );
  await page.locator('[data-testid="provider-story-teardown"]').click();
  await expect(page.locator('[data-testid="provider-story-teardown-status"]')).toHaveText(
    "torn_down",
  );
  await expect(page.locator('[data-testid="provider-story-error"]')).toContainText(
    "provider story teardown incomplete",
  );
  await expect
    .poll(async () => (await readProbe(page)).status, { timeout: 5_000 })
    .toBe("error");
  expect((await readProbe(page)).teardownError).toBe("provider cleanup failed");
});

test("external mode mounts only the production terminal for an existing session", async ({
  page,
}) => {
  const lifecycleRequests: string[] = [];
  const terminalSockets: string[] = [];
  await page.route("**/terminal-stories/provider**", async (route) => {
    lifecycleRequests.push(route.request().url());
    await route.abort();
  });
  await page.routeWebSocket("**/terminal**", (socket) => {
    terminalSockets.push(socket.url());
    socket.close();
  });

  await page.goto(
    "/?external=1&sessionId=terminal-story-external-check&provider=aio&fixture=boxlite",
    { waitUntil: "load" },
  );

  await expect(page.locator('[data-testid="provider-story-mode"]')).toHaveText(
    "external",
  );
  await expect(page.locator('[data-testid="provider-story-readiness"]')).toHaveText(
    "external",
  );
  await expect(page.locator('[data-testid="provider-story-session-id"]')).toHaveText(
    "terminal-story-external-check",
  );
  await expect(page.locator('[data-testid="provider-story-refresh"]')).toBeDisabled();
  await expect(page.locator('[data-testid="provider-story-create"]')).toBeDisabled();
  await expect(page.locator('[data-testid="provider-story-teardown"]')).toBeDisabled();

  await expect.poll(() => terminalSockets.length, { timeout: 10_000 }).toBeGreaterThan(0);
  const terminalUrl = new URL(terminalSockets[0] as string);
  expect(terminalUrl.pathname).toBe("/terminal");
  expect(terminalUrl.searchParams.get("taskId")).toBe(
    "terminal-story-external-check",
  );
  await page.waitForTimeout(500);
  expect(lifecycleRequests).toEqual([]);
  expect(await page.evaluate(() => window.WebSocket.name)).not.toBe(
    "FixtureWebSocket",
  );

  const probe = await readProbe(page);
  expect(probe).toMatchObject({
    mode: "external",
    external: true,
    providerId: "aio",
    sessionId: "terminal-story-external-check",
    readiness: null,
    inventory: null,
    fixtureKind: null,
    descriptor: null,
  });
});

test("external mode fails locally without an explicit terminal-story session id", async ({
  page,
}) => {
  const lifecycleRequests: string[] = [];
  await page.route("**/terminal-stories/provider**", async (route) => {
    lifecycleRequests.push(route.request().url());
    await route.abort();
  });

  await page.goto("/?external=1&sessionId=not-a-story&fixture=aio", {
    waitUntil: "load",
  });

  await expect(page.locator('[data-testid="provider-story-mode"]')).toHaveText(
    "external",
  );
  await expect(page.locator('[data-testid="provider-story-readiness"]')).toHaveText(
    "external-invalid",
  );
  await expect(page.locator('[data-testid="provider-story-error"]')).toContainText(
    "sessionId=terminal-story-*",
  );
  await expect(page.locator('[data-testid="provider-story-empty"]')).toBeVisible();
  expect(lifecycleRequests).toEqual([]);
  const probe = await readProbe(page);
  expect(probe).toMatchObject({
    mode: "external",
    external: true,
    status: "error",
    sessionId: null,
    readiness: null,
    inventory: null,
    fixtureKind: null,
  });
});

const PROVIDER_FIXTURES = {
  aio: {
    sessionId: "provider-fixture-aio-session",
    terminalProtocol: "aio-json-v1",
    commandProtocol: "aio-http-exec-v1",
    workspaceMode: "git",
    retentionMode: "stop-retain",
    current: "PROVIDER_FIXTURE_AIO_CURRENT_FRAME",
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
    current: "PROVIDER_FIXTURE_BOXLITE_CURRENT_FRAME",
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
  test(`fixture ${fixture} renders a fresh native attachment without backend`, async ({
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
      .toContain(expected.current);
    await expect
      .poll(async () => (await readProbe(page)).terminalText, { timeout: 30_000 })
      .toContain(expected.live);
    await expectTerminalRowsVisible(page);

    const attachFrames = await page.evaluate(
      () =>
        (window as ProviderFixtureWindow).__capProviderFixtureAttachFrames ?? [],
    );
    expect(attachFrames).toHaveLength(1);
    expect(attachFrames[0]).toMatchObject({
      type: "terminal_attach",
      protocolVersion: TERMINAL_PROTOCOL_VERSION,
      responseProfileId: XTERM_5_5_0_RESPONSE_PROFILE_ID,
    });
    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (window as ProviderFixtureWindow).__capProviderFixtureAckSeqs
                ?.length ?? 0,
          ),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);
    expect(
      await page.evaluate(
        () =>
          (window as ProviderFixtureWindow).__capProviderFixtureResponses ?? [],
      ),
    ).toContainEqual([0x1b, 0x5b, 0x3f, 0x31, 0x3b, 0x32, 0x63]);

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
      .toContain(expected.current);
    await expectTerminalRowsVisible(page);
    const afterReconnect = (await readProbe(page)).terminalText;
    expect(afterReconnect.split(expected.current)).toHaveLength(2);
    expect(afterReconnect).not.toContain(`PROVIDER_FIXTURE_ECHO:fixture-${fixture}`);

    const screenshot = await page
      .locator('[data-testid="provider-story-terminal-slot"]')
      .screenshot({ animations: "disabled" });
    expect(screenshot.byteLength).toBeGreaterThan(1_000);

    for (const leak of expected.leaks) {
      await expect(page.locator("body")).not.toContainText(leak);
    }
    await teardownFixture(page);
  });
}

test("fixture fresh attach matches the uninterrupted canonical screen and pixels", async ({
  page,
}, testInfo) => {
  await page.goto("/?fixture=boxlite&autostart=1", { waitUntil: "load" });
  await expect
    .poll(async () => (await readProbe(page)).terminalText, { timeout: 30_000 })
    .toContain("PROVIDER_FIXTURE_BOXLITE_LIVE_002");
  await expect
    .poll(async () => (await readProbe(page)).terminalText, {
      timeout: 15_000,
    })
    .toContain("PROVIDER_FIXTURE_BOXLITE_CURRENT_FRAME");
  await expectTerminalRowsVisible(page);

  await page.locator("h1").click();
  await page.waitForTimeout(80);
  const uninterrupted = await readProbe(page);
  expect(uninterrupted.terminalGeometry?.cols).toBeGreaterThan(20);
  expect(uninterrupted.terminalGeometry?.rows).toBeGreaterThan(8);
  expect(uninterrupted.terminalText).not.toMatch(/SNAPSHOT|TAIL_REPLAY/);
  const uninterruptedPath = testInfo.outputPath(
    "fixture-uninterrupted-terminal.png",
  );
  const uninterruptedShot = await page
    .locator('[data-testid="terminal-surface"]')
    .screenshot({ animations: "disabled", path: uninterruptedPath });
  expect(uninterruptedShot.byteLength).toBeGreaterThan(1_000);

  await page.locator('[data-testid="provider-story-reconnect"]').click();
  await expect
    .poll(async () => (await readProbe(page)).mountKey, { timeout: 15_000 })
    .toBeGreaterThan(uninterrupted.mountKey);
  await expect
    .poll(async () => (await readProbe(page)).terminalText, { timeout: 30_000 })
    .toContain("PROVIDER_FIXTURE_BOXLITE_LIVE_002");
  await expect
    .poll(async () => (await readProbe(page)).canonicalScreen, {
      timeout: 15_000,
    })
    .toBe(uninterrupted.canonicalScreen);
  await page.locator("h1").click();
  await page.waitForTimeout(80);

  const reconnected = await readProbe(page);
  expect(reconnected.terminalGeometry).toEqual(uninterrupted.terminalGeometry);
  const freshAttachPath = testInfo.outputPath(
    "fixture-fresh-attach-terminal.png",
  );
  const reconnectedShot = await page
    .locator('[data-testid="terminal-surface"]')
    .screenshot({ animations: "disabled", path: freshAttachPath });
  expect(reconnectedShot.equals(uninterruptedShot)).toBe(true);
  await testInfo.attach("fixture-uninterrupted-terminal", {
    path: uninterruptedPath,
  });
  await testInfo.attach("fixture-fresh-attach-terminal", {
    path: freshAttachPath,
  });
  await teardownFixture(page);
});

test("live terminal output does not steal focus after the operator leaves xterm", async ({
  page,
}) => {
  await page.goto("/?fixture=boxlite&autostart=1", { waitUntil: "load" });
  await expect
    .poll(async () => (await readProbe(page)).terminalText, { timeout: 30_000 })
    .toContain("PROVIDER_FIXTURE_BOXLITE_CURRENT_FRAME");

  const helperTextarea = page.locator(".xterm-helper-textarea");
  await expect(helperTextarea).toBeFocused();
  await page.locator("h1").click();
  await expect(helperTextarea).not.toBeFocused();

  await page.evaluate(() => {
    (window as ProviderFixtureWindow).__capProviderFixtureEmitRaw?.(
      "\r\nCAP_PROVIDER_FIXTURE_FOCUS_REGRESSION\r\n",
    );
  });
  await expect
    .poll(async () => (await readProbe(page)).terminalText, { timeout: 15_000 })
    .toContain("CAP_PROVIDER_FIXTURE_FOCUS_REGRESSION");
  await expect(helperTextarea).not.toBeFocused();
  await teardownFixture(page);
});

test("fixture inventories queries, responses, and byte-preserving provider writes", async ({
  page,
}) => {
  await page.goto("/?fixture=boxlite&autostart=1", { waitUntil: "load" });
  await expect
    .poll(async () => (await readProbe(page)).terminalText, { timeout: 30_000 })
    .toContain("PROVIDER_FIXTURE_BOXLITE_LIVE_002");
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            (window as ProviderFixtureWindow).__capProviderFixtureResponses
              ?.length ?? 0,
        ),
      { timeout: 10_000 },
    )
    .toBe(1);

  expect(
    await page.evaluate(
      () => (window as ProviderFixtureWindow).__capProviderFixtureQueries ?? [],
    ),
  ).toEqual([{ name: "da1", bytes: [0x1b, 0x5b, 0x63] }]);
  expect(
    await page.evaluate(
      () =>
        (window as ProviderFixtureWindow).__capProviderFixtureResponses ?? [],
    ),
  ).toEqual([[0x1b, 0x5b, 0x3f, 0x31, 0x3b, 0x32, 0x63]]);

  await typeTerminalCommand(page, "中🙂");
  const expectedUtf8 = [...new TextEncoder().encode("中🙂\r")];
  await expect
    .poll(
      async () =>
        page.evaluate(() =>
          ((window as ProviderFixtureWindow).__capProviderFixtureProviderWrites ?? [])
            .filter((entry) => entry.type === "keystroke")
            .flatMap((entry) => entry.bytes),
        ),
      { timeout: 10_000 },
    )
    .toEqual(expectedUtf8);

  await page.evaluate(() =>
    (window as ProviderFixtureWindow).__capProviderFixtureEmitRaw?.(
      "\x1b[?1000h\x1b[?1006l",
    ),
  );
  await page.waitForTimeout(100);
  const screen = page.locator(".xterm-screen");
  const bounds = await screen.boundingBox();
  expect(bounds).not.toBeNull();
  await screen.click({
    position: {
      // Legacy X10 mouse encodes the 1-based cell coordinate with a +32
      // offset. The far-right cell in this fixed desktop story is deliberately
      // beyond column 95, so this exercises an actual >=0x80 byte.
      x: Math.max(40, (bounds?.width ?? 80) - 12),
      y: Math.min(60, Math.max(20, (bounds?.height ?? 40) - 10)),
    },
  });
  await expect
    .poll(
      async () =>
        page.evaluate(() =>
          ((window as ProviderFixtureWindow).__capProviderFixtureProviderWrites ?? [])
            .filter((entry) => entry.type === "keystroke")
            .map((entry) => entry.bytes),
        ),
      { timeout: 10_000 },
    )
    .toEqual(
      expect.arrayContaining([
        expect.arrayContaining([0x1b, 0x5b, 0x4d]),
      ]),
    );

  const writes = await page.evaluate(
    () =>
      (window as ProviderFixtureWindow).__capProviderFixtureProviderWrites ?? [],
  );
  expect(writes).toContainEqual({
    type: "terminal_response",
    bytes: [0x1b, 0x5b, 0x3f, 0x31, 0x3b, 0x32, 0x63],
  });
  const legacyMouse = writes.find(
    (entry) =>
      entry.type === "keystroke" &&
      entry.bytes[0] === 0x1b &&
      entry.bytes[1] === 0x5b &&
      entry.bytes[2] === 0x4d,
  );
  expect(legacyMouse?.bytes.some((byte) => byte >= 0x80)).toBe(true);
  expect(JSON.stringify(writes)).not.toMatch(/snapshot|tail_replay/i);
  await teardownFixture(page);
});

test("physical reconnect starts a new attach and connection-local raw origin", async ({
  page,
}) => {
  await page.goto("/?fixture=boxlite&autostart=1", { waitUntil: "load" });

  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            (window as ProviderFixtureWindow).__capProviderFixtureAttachFrames
              ?.length ?? 0,
        ),
      { timeout: 15_000 },
    )
    .toBe(1);
  await expect
    .poll(async () => (await readProbe(page)).terminalText, { timeout: 30_000 })
    .toContain("PROVIDER_FIXTURE_BOXLITE_LIVE_002");

  await page.evaluate(() =>
    (window as ProviderFixtureWindow).__capProviderFixtureCloseOpenSockets?.(1011),
  );
  const attachmentStatus = page.locator(
    '[data-testid="terminal-attachment-status"]',
  );
  // The old xterm buffer intentionally stays mounted behind the reconnect mask
  // until the replacement attachment has reset and flushed. Observe both sides
  // of that product contract so an old current-frame marker cannot satisfy the
  // fresh-attachment assertion while the new terminal is still being restored.
  await expect(attachmentStatus).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            (window as ProviderFixtureWindow).__capProviderFixtureAttachFrames
              ?.length ?? 0,
        ),
      { timeout: 15_000 },
    )
    .toBe(2);

  await expect(attachmentStatus).toBeHidden({ timeout: 30_000 });
  await expect
    .poll(async () => (await readProbe(page)).terminalText, { timeout: 30_000 })
    .toContain("PROVIDER_FIXTURE_BOXLITE_CURRENT_FRAME");
  await expectTerminalRowsVisible(page);

  const origins = await page.evaluate(
    () =>
      (window as ProviderFixtureWindow).__capProviderFixtureConnectionOrigins ??
      [],
  );
  expect(origins).toEqual([0, 0]);
  const text = (await readProbe(page)).terminalText;
  expect(text.split("PROVIDER_FIXTURE_BOXLITE_CURRENT_FRAME")).toHaveLength(2);
  await teardownFixture(page);
});

test("fresh attachment stays concealed until ready and the bootstrap write flush", async ({
  page,
}) => {
  await page.goto("/?fixture=aio&autostart=1", { waitUntil: "load" });
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            (window as ProviderFixtureWindow).__capProviderFixtureAttachFrames
              ?.length ?? 0,
        ),
      { timeout: 15_000 },
    )
    .toBe(1);
  await expect(
    page.locator('[data-testid="terminal-attachment-status"]'),
  ).toBeVisible();
  await expect
    .poll(async () => (await readProbe(page)).terminalText, { timeout: 30_000 })
    .toContain("PROVIDER_FIXTURE_AIO_CURRENT_FRAME");
  await expect(
    page.locator('[data-testid="terminal-attachment-status"]'),
  ).toBeHidden();
  await teardownFixture(page);
});

test("profile mismatch is an explicit reload-required state", async ({ page }) => {
  await page.goto("/?fixture=aio&autostart=1&attachFailure=profile", {
    waitUntil: "load",
  });
  await expect(
    page.locator('[data-testid="terminal-attachment-status"]'),
  ).toContainText("请刷新页面", { timeout: 15_000 });
  await teardownFixture(page);
});

const liveSessionsPendingCleanup = new Set<string>();
const liveCreateResponseTracking = new WeakMap<Page, Set<Promise<void>>>();

function trackLiveCreateResponses(page: Page): void {
  const pending = new Set<Promise<void>>();
  liveCreateResponseTracking.set(page, pending);
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (
      response.request().method() !== "POST" ||
      url.pathname !== "/terminal-stories/provider/sessions" ||
      !response.ok()
    ) {
      return;
    }
    const tracking = response
      .json()
      .then((body: unknown) => {
        if (!body || typeof body !== "object") return;
        const sessionId = (body as { readonly sessionId?: unknown }).sessionId;
        if (typeof sessionId === "string" && sessionId.startsWith("terminal-story-")) {
          liveSessionsPendingCleanup.add(sessionId);
        }
      })
      .catch(() => undefined)
      .finally(() => pending.delete(tracking));
    pending.add(tracking);
  });
}

test.describe("live provider-backed story", () => {
  test.skip(
    !LIVE_ENABLED || !LIVE_API || !LIVE_WS || !LIVE_TOKEN,
    "set CAP_PROVIDER_TERMINAL_STORY_E2E=1, VITE_API_BASE_URL, VITE_WS_URL, and VITE_AUTH_TOKEN to run live provider checks",
  );

  test.beforeEach(async ({ page }) => {
    trackLiveCreateResponses(page);
  });

  test.afterEach(async ({ page, request }) => {
    if (!LIVE_API || !LIVE_TOKEN) return;
    await Promise.allSettled([...(liveCreateResponseTracking.get(page) ?? [])]);
    // Recover a session id even when the assertion/timeout happened between the
    // successful create response and the test body's normal bookkeeping.
    if (!page.isClosed()) {
      try {
        const sessionId = (await readProbe(page)).sessionId;
        if (sessionId?.startsWith("terminal-story-")) {
          liveSessionsPendingCleanup.add(sessionId);
        }
      } catch {
        // The tracked-set path below still covers ids observed before page loss.
      }
    }
    const cleanupResults = await Promise.allSettled(
      [...liveSessionsPendingCleanup].map(async (sessionId) => {
        const response = await request.delete(
          `${LIVE_API}/terminal-stories/provider/sessions/${encodeURIComponent(sessionId)}`,
          { headers: { Authorization: `Bearer ${LIVE_TOKEN}` } },
        );
        expect(response.ok()).toBe(true);
        const body = (await response.json()) as {
          readonly status?: unknown;
          readonly teardownError?: unknown;
          readonly cleanupEvidence?: unknown;
        };
        expect(body.status).toBe("torn_down");
        expect(body.teardownError).toBeUndefined();
        expect(body.cleanupEvidence).toEqual({
          gatewayOwnerReleased: true,
          gatewayViewersReleased: true,
          providerAbsent: true,
          backingRepoRemoved: true,
          telemetryObserverReleased: true,
        });
        liveSessionsPendingCleanup.delete(sessionId);
      }),
    );
    const cleanupFailures = cleanupResults
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        cleanupFailures,
        "provider story afterEach cleanup failed",
      );
    }
  });

  test("fresh attach restores the same native screen without history replay or provider exposure", async ({
    page,
  }, testInfo) => {
    const connections = observeCapTerminalConnections(page);
    await page.goto(`/?provider=${encodeURIComponent(LIVE_PROVIDER)}&autostart=1`, {
      waitUntil: "load",
    });

    await expect
      .poll(async () => (await readProbe(page)).sessionId, { timeout: 60_000 })
      .toMatch(/^terminal-story-/);
    const sessionId = (await readProbe(page)).sessionId;
    expect(sessionId).not.toBeNull();
    liveSessionsPendingCleanup.add(sessionId as string);
    await expect
      .poll(async () => (await readProbe(page)).terminalText, { timeout: 60_000 })
      .toContain("PROVIDER_STORY_READY_FOR_INPUT");
    await expect
      .poll(async () => (await readProbe(page)).terminalText, {
        timeout: 30_000,
      })
      .toContain("PROVIDER_STORY_CURRENT_FRAME");
    await expectTerminalRowsVisible(page);
    await expect.poll(() => connections.length, { timeout: 15_000 }).toBe(1);

    const firstAttach = connections[0];
    expect(firstAttach).toBeDefined();
    expect(receivedText(firstAttach as CapturedTerminalConnection)).not.toMatch(
      /PROVIDER_STORY_(BEGIN|HISTORY_|SPLIT_SAFE_MARKER)/,
    );
    const firstFrame = await readProbe(page);
    expect(firstFrame.terminalText).not.toMatch(
      /PROVIDER_STORY_(BEGIN|HISTORY_|SPLIT_SAFE_MARKER)/,
    );

    await typeTerminalCommand(page, "hello-from-playwright");
    await expect
      .poll(async () => (await readProbe(page)).terminalText, { timeout: 30_000 })
      .toContain("PROVIDER_STORY_ECHO:hello-from-playwright");

    await page.locator('[data-testid="provider-story-toggle-size"]').click();
    await expect
      .poll(async () => (await readProbe(page)).terminalText, { timeout: 30_000 })
      .toMatch(/PROVIDER_STORY_RESIZE:\d+x\d+/);

    await typeTerminalCommand(page, "CAP_STORY_FREEZE");
    await expect
      .poll(async () => (await readProbe(page)).terminalText, { timeout: 30_000 })
      .toContain("PROVIDER_STORY_FROZEN stable");
    await typeTerminalCommand(page, "CAP_STORY_LIVE_ONCE");
    await expect
      .poll(async () => (await readProbe(page)).terminalText, { timeout: 30_000 })
      .toContain("PROVIDER_STORY_LIVE_PROBE exactly-once");
    await expect
      .poll(
        () =>
          occurrenceCount(
            receivedText(firstAttach as CapturedTerminalConnection),
            "PROVIDER_STORY_LIVE_PROBE exactly-once",
          ),
        { timeout: 15_000 },
      )
      .toBe(1);

    await expect
      .poll(async () => (await readProbe(page)).terminalText, {
        timeout: 15_000,
      })
      .toContain("PROVIDER_STORY_ECHO:CAP_STORY_LIVE_ONCE");
    await page.locator("h1").click();
    await page.waitForTimeout(80);
    const uninterrupted = await readProbe(page);
    expect(uninterrupted.terminalGeometry?.cols).toBeGreaterThan(20);
    expect(uninterrupted.terminalGeometry?.rows).toBeGreaterThan(8);
    expect(uninterrupted.terminalText).not.toContain("hello-from-playwright");
    const uninterruptedPath = testInfo.outputPath(
      "live-uninterrupted-terminal.png",
    );
    const uninterruptedShot = await page
      .locator('[data-testid="terminal-surface"]')
      .screenshot({ animations: "disabled", path: uninterruptedPath });
    expect(uninterruptedShot.byteLength).toBeGreaterThan(1_000);

    await page.locator('[data-testid="provider-story-reconnect"]').click();
    await expect
      .poll(async () => (await readProbe(page)).mountKey, { timeout: 15_000 })
      .toBeGreaterThan(uninterrupted.mountKey);
    await expect
      .poll(async () => (await readProbe(page)).terminalText, { timeout: 30_000 })
      .toContain("PROVIDER_STORY_LIVE_PROBE exactly-once");
    await expect
      .poll(async () => (await readProbe(page)).canonicalScreen, {
        timeout: 30_000,
      })
      .toBe(uninterrupted.canonicalScreen);
    await expect.poll(() => connections.length, { timeout: 15_000 }).toBe(2);
    await expectTerminalRowsVisible(page);

    const freshAttach = connections[1];
    expect(freshAttach).toBeDefined();
    await expect
      .poll(
        () =>
          occurrenceCount(
            receivedText(freshAttach as CapturedTerminalConnection),
            "PROVIDER_STORY_LIVE_PROBE exactly-once",
          ),
        { timeout: 15_000 },
      )
      .toBe(1);
    const freshText = receivedText(freshAttach as CapturedTerminalConnection);
    expect(freshText).not.toMatch(
      /PROVIDER_STORY_(BEGIN|HISTORY_|SPLIT_SAFE_MARKER)/,
    );
    expect(freshText).not.toContain("hello-from-playwright");
    const reconnected = await readProbe(page);
    expect(reconnected.terminalGeometry).toEqual(uninterrupted.terminalGeometry);
    expect(reconnected.terminalText).not.toContain("hello-from-playwright");
    expect(reconnected.terminalText).not.toMatch(/SNAPSHOT|TAIL_REPLAY/);

    await page.locator("h1").click();
    await page.waitForTimeout(80);
    const freshAttachPath = testInfo.outputPath(
      "live-fresh-attach-terminal.png",
    );
    const reconnectedShot = await page
      .locator('[data-testid="terminal-surface"]')
      .screenshot({ animations: "disabled", path: freshAttachPath });
    expect(reconnectedShot.equals(uninterruptedShot)).toBe(true);
    await testInfo.attach("live-uninterrupted-terminal", {
      path: uninterruptedPath,
    });
    await testInfo.attach("live-fresh-attach-terminal", {
      path: freshAttachPath,
    });

    const expectedCapOrigin = new URL(LIVE_WS as string).origin;
    for (const connection of connections) {
      expect(connection).toMatchObject({
        origin: expectedCapOrigin,
        pathname: "/terminal",
      });
      expect([
        ...connection.receivedControlTypes,
        ...connection.sentControlTypes,
      ]).not.toEqual(expect.arrayContaining(["snapshot", "tail_replay"]));
    }
    const bodyText = (await page.locator("body").textContent()) ?? "";
    expect(bodyText).not.toMatch(
      /terminalUrl|sandboxId|AIO_SANDBOX_IMAGE|BOXLITE_API_TOKEN|Bearer\s/i,
    );

    await page.locator('[data-testid="provider-story-teardown"]').click();
    await expect
      .poll(async () => (await readProbe(page)).teardownStatus, { timeout: 30_000 })
      .toBe("torn_down");
    const tornDown = await readProbe(page);
    expect(tornDown.teardownError).toBeNull();
    expect(tornDown.error).toBeNull();
    expect(tornDown.cleanupEvidence).toEqual({
      gatewayOwnerReleased: true,
      gatewayViewersReleased: true,
      providerAbsent: true,
      backingRepoRemoved: true,
      telemetryObserverReleased: true,
    });
    await expect
      .poll(() => connections.every((connection) => connection.closed), {
        timeout: 15_000,
      })
      .toBe(true);
  });

  test("multiple disposable viewers expose correlated writes and a provider byte oracle", async ({
    context,
    page,
    request,
  }) => {
    await page.goto(`/?provider=${encodeURIComponent(LIVE_PROVIDER)}&autostart=1`, {
      waitUntil: "load",
    });
    await expect
      .poll(async () => (await readProbe(page)).sessionId, { timeout: 60_000 })
      .toMatch(/^terminal-story-/);
    const sessionId = (await readProbe(page)).sessionId as string;
    liveSessionsPendingCleanup.add(sessionId);
    await expect
      .poll(async () => (await readProbe(page)).terminalText, { timeout: 60_000 })
      .toContain("PROVIDER_STORY_READY_FOR_INPUT");

    const reader = await context.newPage();
    await reader.goto(
      `/?provider=${encodeURIComponent(LIVE_PROVIDER)}&autostart=1&sessionId=${encodeURIComponent(sessionId)}`,
      { waitUntil: "load" },
    );
    await expect
      .poll(async () => (await readProbe(reader)).terminalText, { timeout: 60_000 })
      .toContain("PROVIDER_STORY_CURRENT_FRAME");
    await expect
      .poll(async () => (await readProbe(page)).inventory?.gateway.activeViewerCount, {
        timeout: 30_000,
      })
      .toBe(2);
    const opened = (await readProbe(page)).inventory?.events
      .map(({ event }) => event)
      .filter((event) => event.type === "viewer_opened") ?? [];
    expect(opened).toHaveLength(2);
    expect(new Set(opened.map((event) => event.attachmentId)).size).toBe(2);

    await typeTerminalCommand(reader, "READER_MUST_NOT_WRITE");
    const geometryBeforeReaderFit = (await readProbe(page)).terminalGeometry;
    const resizeEventsBeforeReaderFit =
      (await readProbe(page)).inventory?.events.filter(
        ({ event }) => event.type === "resize",
      ).length ?? 0;
    await reader.locator('[data-testid="provider-story-toggle-size"]').click();
    await reader.waitForTimeout(500);
    expect(
      (await readProbe(page)).inventory?.events.filter(
        ({ event }) => event.type === "resize",
      ).length ?? 0,
    ).toBe(resizeEventsBeforeReaderFit);
    expect((await readProbe(page)).terminalGeometry).toEqual(geometryBeforeReaderFit);

    await page.locator('[data-testid="provider-story-toggle-size"]').click();
    await expect
      .poll(
        async () =>
          (await readProbe(page)).inventory?.events.some(
            ({ event }) =>
              event.type === "resize" && event.authoritative === true,
          ) ?? false,
        { timeout: 15_000 },
      )
      .toBe(true);
    // Return to the original desktop geometry before screen-state comparison.
    await page.locator('[data-testid="provider-story-toggle-size"]').click();
    await expect
      .poll(async () => (await readProbe(page)).terminalGeometry, {
        timeout: 15_000,
      })
      .toEqual(geometryBeforeReaderFit);

    await typeTerminalCommand(page, "中🙂");
    const expectedUtf8Hex = "E4B8ADF09F99820D";
    await expect
      .poll(async () => (await readProbe(page)).terminalText, { timeout: 30_000 })
      .toContain(`PROVIDER_STORY_ORACLE_UTF8:${expectedUtf8Hex}`);

    const screen = page.locator(".xterm-screen");
    const bounds = await screen.boundingBox();
    expect(bounds).not.toBeNull();
    await screen.click({
      position: {
        x: Math.max(40, (bounds?.width ?? 80) - 12),
        y: Math.min(80, Math.max(20, (bounds?.height ?? 40) - 10)),
      },
    });
    await expect
      .poll(async () => (await readProbe(page)).terminalText, { timeout: 30_000 })
      .toMatch(/PROVIDER_STORY_ORACLE_MOUSE:1B5B4D[0-9A-F]{6}/);
    const mouseOracle = /PROVIDER_STORY_ORACLE_MOUSE:([0-9A-F]+)/.exec(
      (await readProbe(page)).terminalText,
    )?.[1];
    expect(mouseOracle).toBeDefined();
    expect(
      Buffer.from(mouseOracle as string, "hex").some((byte) => byte >= 0x80),
    ).toBe(true);

    await expect
      .poll(
        async () => {
          const events = (await readProbe(page)).inventory?.events.map(
            ({ event }) => event,
          );
          const query = events?.find(
            (event) => event.type === "query" && event.admitted === true,
          );
          return {
            query:
              typeof query?.bytesBase64 === "string" &&
              Buffer.from(query.bytesBase64, "base64").byteLength > 0,
            response: events?.some(
              (event) => event.type === "response" && event.accepted === true,
            ),
            responseWrite: events?.some(
              (event) =>
                event.type === "provider_write" &&
                event.source === "terminal_response" &&
                event.outcome === "written",
            ),
          };
        },
        { timeout: 30_000 },
      )
      .toEqual({ query: true, response: true, responseWrite: true });

    const inventory = (await readProbe(page)).inventory;
    expect(inventory?.truncated).toBe(false);
    const keystrokeBytes = Buffer.concat(
      (inventory?.events ?? [])
        .map(({ event }) => event)
        .filter(
          (event) =>
            event.type === "provider_write" && event.source === "keystroke",
        )
        .map((event) => Buffer.from(String(event.bytesBase64), "base64")),
    );
    expect(keystrokeBytes.includes(Buffer.from("中🙂\r", "utf8"))).toBe(true);
    expect(keystrokeBytes.includes(Buffer.from("READER_MUST_NOT_WRITE", "utf8"))).toBe(
      false,
    );
    expect(
      (inventory?.events ?? []).some(({ event }) => {
        if (
          event.type !== "provider_write" ||
          event.source !== "keystroke" ||
          typeof event.bytesBase64 !== "string"
        ) {
          return false;
        }
        const bytes = Buffer.from(event.bytesBase64, "base64");
        return (
          bytes[0] === 0x1b &&
          bytes[1] === 0x5b &&
          bytes[2] === 0x4d &&
          bytes.some((byte) => byte >= 0x80)
        );
      }),
    ).toBe(true);

    await typeTerminalCommand(page, "CAP_STORY_FREEZE");
    await expect
      .poll(async () => (await readProbe(page)).terminalText, { timeout: 30_000 })
      .toContain("PROVIDER_STORY_FROZEN stable");
    const frozenScreen = (await readProbe(page)).canonicalScreen;
    expect((await readProbe(page)).terminalText).toContain(
      "PROVIDER_STORY_CURRENT_FRAME",
    );

    await reader.close();
    await page.close();
    await expect
      .poll(
        async () => {
          const response = await request.get(
            `${LIVE_API}/terminal-stories/provider/sessions/${encodeURIComponent(sessionId)}/inventory`,
            { headers: { Authorization: `Bearer ${LIVE_TOKEN}` } },
          );
          expect(response.ok()).toBe(true);
          const body = (await response.json()) as StoryProbe["inventory"];
          return body?.gateway.activeViewerCount;
        },
        { timeout: 30_000 },
      )
      .toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 350));

    const fresh = await context.newPage();
    await fresh.goto(
      `/?provider=${encodeURIComponent(LIVE_PROVIDER)}&autostart=1&sessionId=${encodeURIComponent(sessionId)}`,
      { waitUntil: "load" },
    );
    await expect
      .poll(async () => (await readProbe(fresh)).canonicalScreen, {
        timeout: 60_000,
      })
      .toBe(frozenScreen);
    await expectTerminalRowsVisible(fresh);
    await fresh.locator('[data-testid="provider-story-teardown"]').click();
    await expect
      .poll(async () => (await readProbe(fresh)).teardownStatus, {
        timeout: 30_000,
      })
      .toBe("torn_down");
    expect((await readProbe(fresh)).cleanupEvidence).toEqual({
      gatewayOwnerReleased: true,
      gatewayViewersReleased: true,
      providerAbsent: true,
      backingRepoRemoved: true,
      telemetryObserverReleased: true,
    });
    await fresh.close();
  });
});
