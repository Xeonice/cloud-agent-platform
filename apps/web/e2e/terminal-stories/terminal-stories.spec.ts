import { expect, test, type Page } from "@playwright/test";

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
