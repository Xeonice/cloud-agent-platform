import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import {
  MAX_TERMINAL_PIXEL_DIMENSION,
  XTERM_5_5_0_RESPONSE_PROFILE_DESCRIPTOR,
  XTERM_5_5_0_RESPONSE_PROFILE_FINGERPRINT,
  XTERM_5_5_0_RESPONSE_PROFILE_FINGERPRINT_SOURCE,
  XTERM_5_5_0_RESPONSE_PROFILE_ID,
  classifyTerminalResponseBytes,
} from "@cap-console/contracts";
import {
  buildTerminalResponseProfileDescriptor,
  type TerminalResponseProfileRuntimeInputs,
} from "@cap-console/ui";

const requireFromUi = createRequire(
  new URL("../../../../packages/ui/package.json", import.meta.url),
);

interface StoryProbe {
  readonly geometry: { cols: number; rows: number } | null;
  readonly resizeCount: number;
  readonly bounds: { width: number; height: number } | null;
  readonly bodyBounds: { width: number; height: number } | null;
  readonly viewport: {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
  } | null;
  readonly visibleText: string;
  readonly serialized: string;
  readonly fixtureDone: boolean;
  readonly liveAppendCount: number;
  readonly writeCount: number;
}

async function readProbe(page: Page, story: "bare" | "session"): Promise<StoryProbe> {
  const text = await page.locator(`[data-testid="${story}-probe"]`).textContent();
  if (!text) throw new Error(`missing ${story} probe`);
  return JSON.parse(text) as StoryProbe;
}

async function waitForFixture(page: Page, story: "bare" | "session"): Promise<void> {
  await expect
    .poll(async () => (await readProbe(page, story)).fixtureDone, {
      timeout: 25_000,
    })
    .toBe(true);
}

async function contentHeight(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluate((node) => {
    const el = node as HTMLElement;
    const styles = window.getComputedStyle(el);
    return (
      el.getBoundingClientRect().height -
      Number.parseFloat(styles.paddingTop) -
      Number.parseFloat(styles.paddingBottom)
    );
  });
}

interface ResponseProbe {
  readonly ready: boolean;
  readonly cases: Readonly<
    Record<string, { readonly data: readonly string[]; readonly binary: readonly string[] }>
  >;
  readonly enabledWindowCases: Readonly<
    Record<string, { readonly data: readonly string[]; readonly binary: readonly string[] }>
  >;
  readonly mouse: { readonly data: readonly string[]; readonly binary: readonly string[] };
  readonly productionProfile: TerminalResponseProfileRuntimeInputs | null;
  readonly enabledWindowProfile: TerminalResponseProfileRuntimeInputs | null;
  readonly productionGeometry: { readonly cols: number; readonly rows: number } | null;
  readonly enabledWindowGeometry: { readonly cols: number; readonly rows: number } | null;
  readonly nativeState: {
    readonly buffer: {
      readonly type: "normal" | "alternate";
      readonly cursorX: number;
      readonly cursorY: number;
    } | null;
    readonly serialized: string;
  } | null;
  readonly normalStateAfterExit: {
    readonly buffer: {
      readonly type: "normal" | "alternate";
      readonly cursorX: number;
      readonly cursorY: number;
    } | null;
    readonly serialized: string;
  } | null;
}

type NativeRole = "writer" | "reader" | "other";

interface NativeProbe {
  readonly scenario: "quiet" | "continuous" | "failed" | "profile" | "matrix";
  readonly mountKey: number;
  readonly connections: Readonly<Partial<Record<NativeRole, string>>>;
  readonly screens: Readonly<Partial<Record<NativeRole, string>>>;
  readonly geometries: Readonly<
    Partial<Record<NativeRole, { readonly cols: number; readonly rows: number } | null>>
  >;
  readonly socket: {
    readonly connections: ReadonlyArray<{
      readonly role: NativeRole;
      readonly taskId: string;
      readonly rawCount: number;
      readonly readyRawCount: number | null;
      readonly emitting: boolean;
    }>;
    readonly clientFrameTypes: readonly string[];
    readonly responses: ReadonlyArray<{
      readonly role: NativeRole;
      readonly bytes: readonly number[];
      readonly outcome:
        | "accepted"
        | "unsolicited"
        | "replayed"
        | "expired"
        | "cross-task";
    }>;
    readonly keystrokes: ReadonlyArray<{
      readonly role: NativeRole;
      readonly bytes: readonly number[];
      readonly outcome: "accepted" | "reader_rejected";
      readonly accountedResponses: number;
    }>;
    readonly resizes: ReadonlyArray<{
      readonly role: NativeRole;
      readonly cols: number;
      readonly rows: number;
      readonly outcome: "accepted" | "reader_rejected";
    }>;
    readonly authoritativeGeometry: { readonly cols: number; readonly rows: number };
  } | null;
}

type NativeMatrixWindow = Window &
  typeof globalThis & {
    __capSessionMatrix?: {
      issueQuery(role: NativeRole, kind: "da1" | "dsr"): boolean;
      armQuery(
        role: NativeRole,
        kind: "da1" | "dsr",
        state: "live" | "expired" | "cross-task",
      ): boolean;
    };
  };

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(
    value.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
  );
}

async function readResponseProbe(page: Page): Promise<ResponseProbe> {
  const text = await page.locator('[data-testid="responses-probe"]').textContent();
  if (!text) throw new Error("missing responses probe");
  return JSON.parse(text) as ResponseProbe;
}

async function readNativeProbe(page: Page): Promise<NativeProbe> {
  const text = await page.locator('[data-testid="native-probe"]').textContent();
  if (!text) throw new Error("missing native probe");
  return JSON.parse(text) as NativeProbe;
}

async function waitForNativeOpen(page: Page, role: NativeRole): Promise<void> {
  await expect
    .poll(async () => (await readNativeProbe(page)).connections[role], {
      timeout: 20_000,
    })
    .toBe("open");
}

async function insertTerminalText(
  page: Page,
  role: NativeRole,
  value: string,
): Promise<void> {
  const textarea = page.locator(
    `[data-testid="native-${role}-slot"] .xterm-helper-textarea`,
  );
  await textarea.focus();
  await page.keyboard.insertText(value);
}

function resolvedPackageVersion(packageName: string): string {
  const manifest = requireFromUi(`${packageName}/package.json`) as {
    readonly version?: unknown;
  };
  if (typeof manifest.version !== "string") {
    throw new Error(`missing resolved version for ${packageName}`);
  }
  return manifest.version;
}

function stringHex(value: string): string {
  return [...new TextEncoder().encode(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function responseData(probe: ResponseProbe, name: string): readonly string[] {
  const result = probe.cases[name];
  expect(result?.binary, `${name} must use onData`).toEqual([]);
  return result?.data ?? [];
}

test("bare terminal mounts a nonblank shared xterm and reports geometry", async ({
  page,
}) => {
  await page.goto("/?story=bare", { waitUntil: "load" });
  await waitForFixture(page, "bare");

  const probe = await readProbe(page, "bare");
  expect(probe.geometry?.cols).toBeGreaterThan(20);
  expect(probe.geometry?.rows).toBeGreaterThan(8);
  expect(probe.bounds?.width).toBeGreaterThan(400);
  expect(probe.bounds?.height).toBeGreaterThan(250);
  expect(probe.visibleText.length + probe.serialized.length).toBeGreaterThan(100);
});

test("finished Web reports default raw history disabled without mounting xterm", async ({
  page,
}) => {
  let castReads = 0;
  await page.route("**/tasks/terminal-story-disabled-cast/cast", async (route) => {
    castReads += 1;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ code: "terminal_raw_recording_disabled" }),
    });
  });

  await page.goto("/?story=cast-disabled", { waitUntil: "load" });
  const story = page.locator('[data-testid="cast-disabled-story"]');
  await expect(story).toContainText("终端历史暂未保留");
  await expect(story).toContainText("对话记录仍可正常回看");
  expect(castReads).toBe(1);
  await expect(story.locator(".xterm")).toHaveCount(0);
  await expect(story.locator("canvas")).toHaveCount(0);
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 820, height: 1180 },
] as const) {
  test(`session shell fills the viewport slot @ ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/?story=session", { waitUntil: "load" });
    await waitForFixture(page, "session");

    const shell = await page.locator('[data-testid="session-story-shell"]').boundingBox();
    const header = await page.locator('[data-testid="session-story-header"]').boundingBox();
    const slot = await page.locator('[data-testid="session-story-slot"]').boundingBox();
    const article = await page
      .locator('[data-testid="session-terminal-article"]')
      .boundingBox();
    const body = await page.locator('[data-testid="terminal-story-body"]').boundingBox();
    const surface = await page.locator('[data-testid="terminal-surface"]').boundingBox();

    expect(shell).not.toBeNull();
    expect(header).not.toBeNull();
    expect(slot).not.toBeNull();
    expect(article).not.toBeNull();
    expect(body).not.toBeNull();
    expect(surface).not.toBeNull();

    expect(Math.abs((shell?.height ?? 0) - viewport.height)).toBeLessThanOrEqual(2);
    expect(Math.abs((article?.height ?? 0) - (slot?.height ?? 0))).toBeLessThanOrEqual(2);
    const bodyContentHeight = await contentHeight(page, '[data-testid="terminal-story-body"]');
    expect(Math.abs((surface?.height ?? 0) - bodyContentHeight)).toBeLessThanOrEqual(8);
    expect((article?.height ?? 0) / (shell?.height ?? 1)).toBeGreaterThan(0.7);
  });
}

test("long output remains scrollable to earlier history while live output continues", async ({
  page,
}) => {
  await page.goto("/?story=session", { waitUntil: "load" });
  await waitForFixture(page, "session");

  const bottomProbe = await readProbe(page, "session");
  expect(bottomProbe.viewport?.scrollHeight).toBeGreaterThan(
    bottomProbe.viewport?.clientHeight ?? 0,
  );
  expect(bottomProbe.liveAppendCount).toBe(2);

  await page.locator('[data-testid="session-scroll-top"]').click();
  await expect
    .poll(async () => (await readProbe(page, "session")).visibleText, {
      timeout: 10_000,
    })
    .toContain("CAP_TERMINAL_STORY_BEGIN");
});

test("Chinese and split UTF-8 fixture text renders intact", async ({ page }) => {
  await page.goto("/?story=bare", { waitUntil: "load" });
  await waitForFixture(page, "bare");

  const probe = await readProbe(page, "bare");
  const output = `${probe.serialized}\n${probe.visibleText}`;
  expect(output).toContain("中文渲染正常");
  expect(output).toContain("汉字边界");
  expect(output).not.toContain("\uFFFD");
});

test("container resize changes reported xterm geometry", async ({ page }) => {
  await page.goto("/?story=bare", { waitUntil: "load" });
  await waitForFixture(page, "bare");

  const before = await readProbe(page, "bare");
  await page.locator('[data-testid="bare-toggle-size"]').click();

  await expect
    .poll(async () => (await readProbe(page, "bare")).geometry, {
      timeout: 10_000,
    })
    .not.toEqual(before.geometry);

  const after = await readProbe(page, "bare");
  expect(after.resizeCount).toBeGreaterThan(before.resizeCount);
});

test("production wrapper runtime fingerprint and response bytes conform exactly", async ({
  page,
}) => {
  expect(XTERM_5_5_0_RESPONSE_PROFILE_ID).toBe(
    "xterm-response-v1-sha256-e491643e62538a297c8e2d03ec0396657b5575d8e9f56f56c5bdf44a0e4afd82",
  );
  await page.goto("/?story=responses", { waitUntil: "load" });
  await expect
    .poll(async () => (await readResponseProbe(page)).ready, { timeout: 20_000 })
    .toBe(true);

  const probe = await readResponseProbe(page);
  expect(probe.productionProfile).not.toBeNull();
  const runtimeDescriptor = buildTerminalResponseProfileDescriptor({
    runtimeInputs: probe.productionProfile!,
    schemaVersion: XTERM_5_5_0_RESPONSE_PROFILE_DESCRIPTOR.schemaVersion,
    responseClasses: XTERM_5_5_0_RESPONSE_PROFILE_DESCRIPTOR.responseClasses,
    resolvePackageVersion: resolvedPackageVersion,
  });
  expect(runtimeDescriptor).toEqual(XTERM_5_5_0_RESPONSE_PROFILE_DESCRIPTOR);
  const runtimeSource = JSON.stringify(runtimeDescriptor);
  expect(runtimeSource).toBe(XTERM_5_5_0_RESPONSE_PROFILE_FINGERPRINT_SOURCE);
  expect(createHash("sha256").update(runtimeSource).digest("hex")).toBe(
    XTERM_5_5_0_RESPONSE_PROFILE_FINGERPRINT,
  );

  const rows = probe.productionGeometry?.rows;
  expect(rows).toBeGreaterThan(0);
  const expectedSingleResponses: Record<string, string> = {
    "da1-7bit": "\x1b[?1;2c",
    "da1-c1": "\x1b[?1;2c",
    da2: "\x1b[>0;276;0c",
    "da2-c1": "\x1b[>0;276;0c",
    dsr: "\x1b[0n",
    cpr: "\x1b[1;1R",
    "private-cpr": "\x1b[?1;1R",
    "decrqm-ansi-known": "\x1b[4;2$y",
    "decrqm-ansi-unknown": "\x1b[9999;0$y",
    "decrqm-private-known": "\x1b[?1;2$y",
    "decrqm-private-boundary": "\x1b[?999999;0$y",
    "decrqm-private-c1": "\x1b[?2026;0$y",
    "decrqss-sgr": "\x1bP1$r0m\x1b\\",
    "decrqss-margins": `\x1bP1$r1;${rows}r\x1b\\`,
    "decrqss-cursor-style": "\x1bP1$r1 q\x1b\\",
    "decrqss-protection": "\x1bP1$r0\"q\x1b\\",
    "decrqss-conformance": "\x1bP1$r61;1\"p\x1b\\",
    "decrqss-unknown": "\x1bP0$r\x1b\\",
    "decrqss-c1": "\x1bP1$r0m\x1b\\",
    "osc4-bel": "\x1b]4;0;rgb:2e2e/3434/3636\x1b\\",
    "osc4-st-boundary": "\x1b]4;255;rgb:eeee/eeee/eeee\x1b\\",
    "osc10-bel": "\x1b]10;rgb:e8e8/e8e8/e8e8\x1b\\",
    "osc11-st": "\x1b]11;rgb:0505/0505/0505\x1b\\",
    "osc12-c1": "\x1b]12;rgb:e8e8/e8e8/e8e8\x1b\\",
  };

  for (const [name, expectedResponse] of Object.entries(expectedSingleResponses)) {
    expect(responseData(probe, name), `${name} exact response bytes`).toEqual([
      stringHex(expectedResponse),
    ]);
    expect(classifyTerminalResponseBytes(hexBytes(stringHex(expectedResponse)))).not.toBeNull();
  }

  expect(responseData(probe, "osc4-multiple")).toEqual([
    stringHex(expectedSingleResponses["osc4-bel"] ?? ""),
    stringHex(expectedSingleResponses["osc4-st-boundary"] ?? ""),
  ]);
  expect(responseData(probe, "osc10-stacked-three")).toEqual([
    stringHex(expectedSingleResponses["osc10-bel"] ?? ""),
    stringHex(expectedSingleResponses["osc11-st"] ?? ""),
    stringHex(expectedSingleResponses["osc12-c1"] ?? ""),
  ]);
  for (const name of [
    "window14-disabled",
    "window16-disabled",
    "window18-disabled",
  ]) {
    expect(probe.cases[name]).toEqual({ data: [], binary: [] });
  }

  expect(probe.enabledWindowProfile?.windowOptions).toEqual({
    getWinSizePixels: true,
    getCellSizePixels: true,
    getWinSizeChars: true,
  });
  const windowExpected = {
    "window14-enabled": "window_14",
    "window16-enabled-c1": "window_16",
    "window18-enabled": "window_18",
  } as const;
  for (const [name, responseClass] of Object.entries(windowExpected)) {
    const result = probe.enabledWindowCases[name];
    expect(result?.binary).toEqual([]);
    expect(result?.data).toHaveLength(1);
    const classification = classifyTerminalResponseBytes(
      hexBytes(result?.data[0] ?? ""),
    );
    expect(classification?.responseClass).toBe(responseClass);
    if (classification && "height" in classification) {
      expect(classification.height).toBeGreaterThan(0);
      expect(classification.width).toBeGreaterThan(0);
      expect(classification.height).toBeLessThanOrEqual(
        responseClass === "window_18" ? 1_000 : MAX_TERMINAL_PIXEL_DIMENSION,
      );
      expect(classification.width).toBeLessThanOrEqual(
        responseClass === "window_18" ? 1_000 : MAX_TERMINAL_PIXEL_DIMENSION,
      );
      if (responseClass === "window_18") {
        expect({
          rows: classification.height,
          cols: classification.width,
        }).toEqual(probe.enabledWindowGeometry);
      }
    }
  }
});

test("production wrapper preserves native screen state and input channels", async ({
  page,
}, testInfo) => {
  await page.goto("/?story=responses", { waitUntil: "load" });
  await expect
    .poll(async () => (await readResponseProbe(page)).ready, { timeout: 20_000 })
    .toBe(true);

  const native = (await readResponseProbe(page)).nativeState;
  expect(native?.buffer).toEqual({
    type: "alternate",
    cursorX: 11,
    cursorY: 3,
  });
  expect(native?.serialized).toContain("\x1b[?1049h");
  expect(native?.serialized).toContain("CAP_NATIVE_ALT_FRAME");
  expect(native?.serialized).toContain("中文光标样式状态");
  expect(native?.serialized).toContain("\x1b[38;2;52;211;153;1m");
  const productionRows = page.locator(
    '[data-testid="responses-production-surface"] .xterm-rows',
  );
  await expect(productionRows).toContainText("CAP_NATIVE_ALT_FRAME");
  await expect(productionRows).toContainText("中文光标样式状态");
  await expect(productionRows).not.toContainText("NORMAL_BUFFER_SENTINEL");

  const productionScreen = page.locator(
    '[data-testid="responses-production-surface"] .xterm-screen',
  );

  await page.locator('[data-testid="responses-mouse-sgr"]').click();
  await productionScreen.click({ position: { x: 100, y: 40 } });
  await page.locator('[data-testid="responses-mouse-binary"]').click();
  await productionScreen.click({ position: { x: 300, y: 60 } });
  await expect
    .poll(async () => (await readResponseProbe(page)).mouse, {
      timeout: 10_000,
    })
    .toMatchObject({
      data: expect.arrayContaining([expect.stringMatching(/^1b5b3c/)]),
      binary: expect.arrayContaining([expect.stringMatching(/^1b5b4d/)]),
    });

  const screenshotPath = testInfo.outputPath("production-response-profile.png");
  const screenshot = await page.locator('[data-testid="responses-terminal-article"]')
    .screenshot({ animations: "disabled", path: screenshotPath });
  expect(screenshot.byteLength).toBeGreaterThan(1_000);

  await page.locator('[data-testid="responses-exit-alt"]').click();
  await expect
    .poll(async () => (await readResponseProbe(page)).normalStateAfterExit)
    .not.toBeNull();
  const afterExit = (await readResponseProbe(page)).normalStateAfterExit;
  expect(afterExit?.buffer?.type).toBe("normal");
  expect(afterExit?.serialized).toContain("NORMAL_BUFFER_SENTINEL");
});

test("production SessionTerminal reveals an equivalent quiet frame after fresh reconnect", async ({
  page,
}, testInfo) => {
  await page.goto("/?story=native&scenario=quiet", { waitUntil: "load" });
  await expect(
    page.locator('[data-testid="native-writer-slot"] [data-testid="terminal-attachment-status"]'),
  ).toContainText("正在");
  await waitForNativeOpen(page, "writer");
  await expect
    .poll(async () => (await readNativeProbe(page)).screens.writer, {
      timeout: 15_000,
    })
    .toContain("QUIET_CURRENT_FRAME");

  const before = await readNativeProbe(page);
  expect(before.screens.writer).toContain("中文静止画面");
  expect(before.screens.writer).not.toMatch(/SNAPSHOT|TAIL_REPLAY/);
  expect(before.socket?.connections[0]?.readyRawCount).toBe(3);
  const firstPath = testInfo.outputPath("session-quiet-first.png");
  const firstScreenshot = await page
    .locator('[data-testid="native-writer-slot"] [data-testid="terminal-surface"]')
    .screenshot({ animations: "disabled", path: firstPath });
  expect(firstScreenshot.byteLength).toBeGreaterThan(1_000);

  await page.locator('[data-testid="native-reconnect"]').click();
  await expect
    .poll(async () => (await readNativeProbe(page)).mountKey, { timeout: 10_000 })
    .toBeGreaterThan(before.mountKey);
  await waitForNativeOpen(page, "writer");
  await expect
    .poll(async () => (await readNativeProbe(page)).screens.writer, {
      timeout: 15_000,
    })
    .toBe(before.screens.writer);
  const secondPath = testInfo.outputPath("session-quiet-fresh-attach.png");
  const secondScreenshot = await page
    .locator('[data-testid="native-writer-slot"] [data-testid="terminal-surface"]')
    .screenshot({ animations: "disabled", path: secondPath });
  expect(secondScreenshot.equals(firstScreenshot)).toBe(true);
});

test("production SessionTerminal reveals at the continuous deadline and keeps converging", async ({
  page,
}) => {
  await page.goto("/?story=native&scenario=continuous", { waitUntil: "load" });
  await waitForNativeOpen(page, "writer");
  const atReveal = await readNativeProbe(page);
  const connectionAtReveal = atReveal.socket?.connections.find(
    (connection) => connection.role === "writer",
  );
  expect(connectionAtReveal?.readyRawCount).toBeGreaterThan(0);
  expect(connectionAtReveal?.emitting).toBe(true);
  await expect(
    page.locator('[data-testid="native-writer-slot"] [data-testid="terminal-attachment-status"]'),
  ).toBeHidden();

  await expect
    .poll(async () => (await readNativeProbe(page)).screens.writer, {
      timeout: 15_000,
    })
    .toContain("CONTINUOUS_FRAME_24");
  const settled = await readNativeProbe(page);
  const connection = settled.socket?.connections.find(
    (candidate) => candidate.role === "writer",
  );
  expect(connection?.emitting).toBe(false);
  expect(connection?.rawCount).toBe(24);
  expect(connection?.readyRawCount).toBeLessThan(connection?.rawCount ?? 0);
});

for (const failure of [
  {
    scenario: "failed",
    connection: "error",
    message: "实时终端附件失败：provider_failed",
  },
  {
    scenario: "profile",
    connection: "reload-required",
    message: "终端协议不匹配，请刷新页面后重试",
  },
] as const) {
  test(`production SessionTerminal surfaces ${failure.scenario} instead of a blank success`, async ({
    page,
  }) => {
    await page.goto(`/?story=native&scenario=${failure.scenario}`, {
      waitUntil: "load",
    });
    await expect
      .poll(async () => (await readNativeProbe(page)).connections.writer, {
        timeout: 15_000,
      })
      .toBe(failure.connection);
    await expect(
      page.locator(
        '[data-testid="native-writer-slot"] [data-testid="terminal-attachment-status"]',
      ),
    ).toContainText(failure.message);
    await expect(
      page.locator('[data-testid="native-writer-slot"] [data-testid="terminal-surface"]'),
    ).toHaveClass(/opacity-0/);
  });
}

test("production SessionTerminal keeps reader fit local and writer resize authoritative", async ({
  page,
}) => {
  await page.goto("/?story=native&scenario=matrix", { waitUntil: "load" });
  await Promise.all([
    waitForNativeOpen(page, "writer"),
    waitForNativeOpen(page, "reader"),
    waitForNativeOpen(page, "other"),
  ]);

  await insertTerminalText(page, "writer", "W");
  await expect
    .poll(
      async () =>
        (await readNativeProbe(page)).socket?.keystrokes.filter(
          (entry) => entry.role === "writer" && entry.outcome === "accepted",
        ).length ?? 0,
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);

  const beforeWriterResize = await readNativeProbe(page);
  const initialGeometry = beforeWriterResize.socket?.authoritativeGeometry;
  await page.locator('[data-testid="native-resize-writer"]').click();
  await expect
    .poll(
      async () => {
        const current = await readNativeProbe(page);
        const accepted = current.socket?.resizes.filter(
          (entry) => entry.role === "writer" && entry.outcome === "accepted",
        );
        return accepted?.at(-1)
          ? { cols: accepted.at(-1)?.cols, rows: accepted.at(-1)?.rows }
          : null;
      },
      { timeout: 10_000 },
    )
    .not.toEqual(initialGeometry);

  await page.waitForTimeout(500);
  const afterWriterResize = await readNativeProbe(page);
  expect(afterWriterResize.geometries.writer).toEqual(
    afterWriterResize.socket?.authoritativeGeometry,
  );
  expect(afterWriterResize.geometries.reader).toEqual(
    afterWriterResize.socket?.authoritativeGeometry,
  );
  const resizeFrameCount = afterWriterResize.socket?.clientFrameTypes.filter(
    (type) => type === "resize",
  ).length;

  await page.locator('[data-testid="native-resize-reader"]').click();
  await page.waitForTimeout(500);
  const afterReaderFit = await readNativeProbe(page);
  expect(
    afterReaderFit.socket?.clientFrameTypes.filter((type) => type === "resize").length,
  ).toBe(resizeFrameCount);
  expect(afterReaderFit.socket?.authoritativeGeometry).toEqual(
    afterWriterResize.socket?.authoritativeGeometry,
  );
  expect(afterReaderFit.geometries.reader).toEqual(
    afterWriterResize.socket?.authoritativeGeometry,
  );
});

test("production SessionTerminal preserves response ordering and Gateway rejection/accounting boundaries", async ({
  page,
}) => {
  const da1 = "\x1b[?1;2c";
  const dsr = "\x1b[0n";
  const da1Bytes = [...new TextEncoder().encode(da1)];
  const dsrBytes = [...new TextEncoder().encode(dsr)];
  await page.goto("/?story=native&scenario=matrix", { waitUntil: "load" });
  await Promise.all([
    waitForNativeOpen(page, "writer"),
    waitForNativeOpen(page, "reader"),
    waitForNativeOpen(page, "other"),
  ]);

  await insertTerminalText(page, "writer", "W");
  await expect
    .poll(
      async () =>
        (await readNativeProbe(page)).socket?.keystrokes.some(
          (entry) => entry.role === "writer" && entry.outcome === "accepted",
        ) ?? false,
      { timeout: 10_000 },
    )
    .toBe(true);

  expect(
    await page.evaluate(() => {
      const matrixWindow = window as NativeMatrixWindow;
      return [
        matrixWindow.__capSessionMatrix?.armQuery("writer", "da1", "live"),
        matrixWindow.__capSessionMatrix?.armQuery("writer", "dsr", "live"),
      ];
    }),
  ).toEqual([true, true]);
  await insertTerminalText(page, "writer", `${da1}${dsr}`);
  await expect
    .poll(
      async () =>
        (await readNativeProbe(page)).socket?.responses.filter(
          (entry) => entry.role === "writer" && entry.outcome === "accepted",
        ).length ?? 0,
      { timeout: 10_000 },
    )
    .toBe(2);
  const ordered = (await readNativeProbe(page)).socket?.responses.filter(
    (entry) => entry.role === "writer" && entry.outcome === "accepted",
  );
  expect(ordered?.map((entry) => entry.bytes)).toEqual([da1Bytes, dsrBytes]);

  expect(
    await page.evaluate(() =>
      (window as NativeMatrixWindow).__capSessionMatrix?.issueQuery("reader", "da1"),
    ),
  ).toBe(true);
  await expect
    .poll(
      async () =>
        (await readNativeProbe(page)).socket?.responses.some(
          (entry) => entry.role === "reader" && entry.outcome === "accepted",
        ) ?? false,
      { timeout: 10_000 },
    )
    .toBe(true);

  await insertTerminalText(page, "reader", da1);
  await expect
    .poll(
      async () =>
        (await readNativeProbe(page)).socket?.responses.some(
          (entry) => entry.role === "reader" && entry.outcome === "replayed",
        ) ?? false,
      { timeout: 10_000 },
    )
    .toBe(true);

  expect(
    await page.evaluate(() =>
      (window as NativeMatrixWindow).__capSessionMatrix?.armQuery(
        "reader",
        "dsr",
        "expired",
      ),
    ),
  ).toBe(true);
  await insertTerminalText(page, "reader", dsr);
  await expect
    .poll(
      async () =>
        (await readNativeProbe(page)).socket?.responses.some(
          (entry) => entry.role === "reader" && entry.outcome === "expired",
        ) ?? false,
      { timeout: 10_000 },
    )
    .toBe(true);

  expect(
    await page.evaluate(() =>
      (window as NativeMatrixWindow).__capSessionMatrix?.armQuery(
        "reader",
        "da1",
        "cross-task",
      ),
    ),
  ).toBe(true);
  await insertTerminalText(page, "reader", da1);
  await expect
    .poll(
      async () =>
        (await readNativeProbe(page)).socket?.responses.some(
          (entry) => entry.role === "reader" && entry.outcome === "cross-task",
        ) ?? false,
      { timeout: 10_000 },
    )
    .toBe(true);

  await insertTerminalText(page, "other", dsr);
  await expect
    .poll(
      async () =>
        (await readNativeProbe(page)).socket?.responses.some(
          (entry) => entry.role === "other" && entry.outcome === "unsolicited",
        ) ?? false,
      { timeout: 10_000 },
    )
    .toBe(true);

  expect(
    await page.evaluate(() =>
      (window as NativeMatrixWindow).__capSessionMatrix?.armQuery(
        "writer",
        "da1",
        "live",
      ),
    ),
  ).toBe(true);
  const mixed = `${da1}human`;
  await insertTerminalText(page, "writer", mixed);
  await expect
    .poll(
      async () =>
        (await readNativeProbe(page)).socket?.keystrokes.some(
          (entry) =>
            entry.role === "writer" &&
            entry.accountedResponses === 1 &&
            entry.outcome === "accepted",
        ) ?? false,
      { timeout: 10_000 },
    )
    .toBe(true);
  const accountingWrite = (await readNativeProbe(page)).socket?.keystrokes.find(
    (entry) => entry.role === "writer" && entry.accountedResponses === 1,
  );
  expect(accountingWrite?.bytes).toEqual([...new TextEncoder().encode(mixed)]);

  const ambiguous = "\x1b[?1;";
  await insertTerminalText(page, "writer", ambiguous);
  await expect
    .poll(
      async () =>
        (await readNativeProbe(page)).socket?.keystrokes.some(
          (entry) =>
            entry.role === "writer" &&
            entry.accountedResponses === 0 &&
            JSON.stringify(entry.bytes) ===
              JSON.stringify([...new TextEncoder().encode(ambiguous)]),
        ) ?? false,
      { timeout: 10_000 },
    )
    .toBe(true);
});
