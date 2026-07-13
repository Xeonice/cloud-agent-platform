import { afterEach, describe, expect, it, vi } from "vitest";

import { copyText } from "./copy-text";

class FakeRange {
  constructor(readonly id: string) {}

  cloneRange(): FakeRange {
    return new FakeRange(this.id);
  }
}

class FakeSelection {
  ranges: FakeRange[];

  constructor(ranges: FakeRange[] = []) {
    this.ranges = ranges;
  }

  get rangeCount(): number {
    return this.ranges.length;
  }

  getRangeAt(index: number): FakeRange {
    const range = this.ranges[index];
    if (!range) throw new Error("range out of bounds");
    return range;
  }

  removeAllRanges(): void {
    this.ranges = [];
  }

  addRange(range: FakeRange): void {
    this.ranges.push(range);
  }
}

class FakeElement {
  parentNode: FakeBody | null = null;
  focusCalls: Array<FocusOptions | undefined> = [];

  constructor(protected readonly owner: FakeDocument) {}

  focus(options?: FocusOptions): void {
    this.focusCalls.push(options);
    this.owner.activeElement = this;
  }
}

class FakeInput extends FakeElement {
  selectionStart: number | null = 2;
  selectionEnd: number | null = 7;
  selectionDirection: "forward" | "backward" | "none" | null = "backward";
  selectionRangeCalls: Array<{
    start: number;
    end: number;
    direction: "forward" | "backward" | "none" | undefined;
  }> = [];

  setSelectionRange(
    start: number,
    end: number,
    direction?: "forward" | "backward" | "none",
  ): void {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction ?? "none";
    this.selectionRangeCalls.push({ start, end, direction });
  }
}

class FakeTextarea extends FakeInput {
  value = "";
  readOnly = false;
  tabIndex = 0;
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  selectCalls = 0;

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  select(): void {
    this.selectCalls += 1;
    this.owner.activeElement = this;
    this.owner.selection.removeAllRanges();
  }
}

class FakeBody {
  readonly children: FakeTextarea[] = [];
  readonly appended: FakeTextarea[] = [];

  appendChild(textarea: FakeTextarea): FakeTextarea {
    textarea.parentNode = this;
    this.children.push(textarea);
    this.appended.push(textarea);
    return textarea;
  }

  removeChild(textarea: FakeTextarea): FakeTextarea {
    const index = this.children.indexOf(textarea);
    if (index >= 0) this.children.splice(index, 1);
    textarea.parentNode = null;
    return textarea;
  }
}

class FakeDocument {
  readonly body = new FakeBody();
  readonly selection = new FakeSelection([new FakeRange("before-copy")]);
  activeElement: FakeElement | null = null;
  execCommand = vi.fn<(command: string) => boolean>(() => true);

  createElement(tagName: string): FakeTextarea {
    if (tagName !== "textarea") throw new Error(`unexpected tag: ${tagName}`);
    return new FakeTextarea(this);
  }

  getSelection(): FakeSelection {
    return this.selection;
  }
}

function installBrowser(options?: {
  secure?: boolean;
  clipboard?: { writeText: (text: string) => Promise<void> };
  document?: FakeDocument;
}): FakeDocument {
  const documentRef = options?.document ?? new FakeDocument();
  vi.stubGlobal("window", { isSecureContext: options?.secure ?? false });
  vi.stubGlobal(
    "navigator",
    options?.clipboard ? { clipboard: options.clipboard } : {},
  );
  vi.stubGlobal("document", documentRef);
  return documentRef;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("copyText", () => {
  it("prefers the asynchronous Clipboard API in a secure context", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
    const documentRef = installBrowser({
      secure: true,
      clipboard: { writeText },
    });

    await expect(copyText("ABCD-1234")).resolves.toEqual({
      ok: true,
      method: "clipboard",
    });
    expect(writeText).toHaveBeenCalledExactlyOnceWith("ABCD-1234");
    expect(documentRef.execCommand).not.toHaveBeenCalled();
    expect(documentRef.body.appended).toHaveLength(0);
  });

  it("uses compatibility copying when navigator.clipboard is missing on a non-secure origin", async () => {
    const documentRef = installBrowser({ secure: false });

    await expect(copyText("HTTP-CODE")).resolves.toEqual({
      ok: true,
      method: "compatibility",
    });

    expect(documentRef.execCommand).toHaveBeenCalledExactlyOnceWith("copy");
    const textarea = documentRef.body.appended[0];
    expect(textarea).toBeDefined();
    expect(textarea).toMatchObject({
      value: "HTTP-CODE",
      readOnly: true,
      tabIndex: -1,
      selectCalls: 1,
    });
    expect(textarea?.attributes.get("readonly")).toBe("");
    expect(textarea?.style).toMatchObject({
      position: "fixed",
      left: "-9999px",
      opacity: "0",
    });
    expect(documentRef.body.children).toHaveLength(0);
    expect(textarea?.parentNode).toBeNull();
  });

  it("falls back after the secure Clipboard API rejects with NotAllowedError", async () => {
    const denied = Object.assign(new Error("clipboard denied"), {
      name: "NotAllowedError",
    });
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValue(denied);
    const documentRef = installBrowser({
      secure: true,
      clipboard: { writeText },
    });

    await expect(copyText("DENIED-CODE")).resolves.toEqual({
      ok: true,
      method: "compatibility",
    });
    expect(writeText).toHaveBeenCalledExactlyOnceWith("DENIED-CODE");
    expect(documentRef.execCommand).toHaveBeenCalledExactlyOnceWith("copy");
  });

  it("reports compatibility failure when execCommand does not positively return true", async () => {
    const documentRef = installBrowser();
    documentRef.execCommand.mockReturnValue(false);

    await expect(copyText("NOT-COPIED")).resolves.toEqual({
      ok: false,
      reason: "copy_failed",
    });
    expect(documentRef.execCommand).toHaveBeenCalledExactlyOnceWith("copy");
  });

  it("removes its temporary node even when compatibility copying throws", async () => {
    const documentRef = installBrowser();
    documentRef.execCommand.mockImplementation(() => {
      throw new Error("copy command failed");
    });

    await expect(copyText("THROWS")).resolves.toEqual({
      ok: false,
      reason: "copy_failed",
    });
    expect(documentRef.body.appended).toHaveLength(1);
    expect(documentRef.body.children).toHaveLength(0);
    expect(documentRef.body.appended[0]?.parentNode).toBeNull();
  });

  it("restores the previous focus, control selection, and document ranges", async () => {
    const documentRef = new FakeDocument();
    const originalInput = new FakeInput(documentRef);
    documentRef.activeElement = originalInput;
    installBrowser({ document: documentRef });

    await expect(copyText("RESTORE")).resolves.toMatchObject({ ok: true });

    expect(documentRef.activeElement).toBe(originalInput);
    expect(originalInput.focusCalls).toEqual([{ preventScroll: true }]);
    expect(originalInput.selectionRangeCalls).toContainEqual({
      start: 2,
      end: 7,
      direction: "backward",
    });
    expect(documentRef.selection.ranges).toHaveLength(1);
    expect(documentRef.selection.ranges[0]?.id).toBe("before-copy");
    expect(documentRef.body.children).toHaveLength(0);
  });

  it("returns an unsupported result for manual-copy recovery outside a browser", async () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("document", undefined);

    await expect(copyText("MANUAL-CODE")).resolves.toEqual({
      ok: false,
      reason: "unsupported",
    });
  });
});
