export type CopyTextMethod = "clipboard" | "compatibility";

export type CopyTextResult =
  | { ok: true; method: CopyTextMethod }
  | { ok: false; reason: "unsupported" | "copy_failed" };

type FocusableElement = Element & {
  focus: (options?: FocusOptions) => void;
};

type SelectionControl = FocusableElement & {
  selectionStart: number | null;
  selectionEnd: number | null;
  selectionDirection: "forward" | "backward" | "none" | null;
  setSelectionRange: (
    start: number,
    end: number,
    direction?: "forward" | "backward" | "none",
  ) => void;
};

type SavedControlSelection = {
  element: SelectionControl;
  start: number;
  end: number;
  direction: "forward" | "backward" | "none" | undefined;
};

type CompatibilityCopyResult = {
  supported: boolean;
  copied: boolean;
};

function isFocusableElement(element: Element | null): element is FocusableElement {
  return element !== null && typeof (element as FocusableElement).focus === "function";
}

function captureControlSelection(
  element: Element | null,
): SavedControlSelection | null {
  if (!isFocusableElement(element)) return null;

  const candidate = element as Partial<SelectionControl>;
  if (
    typeof candidate.selectionStart !== "number" ||
    typeof candidate.selectionEnd !== "number" ||
    typeof candidate.setSelectionRange !== "function"
  ) {
    return null;
  }

  const direction =
    candidate.selectionDirection === "forward" ||
    candidate.selectionDirection === "backward" ||
    candidate.selectionDirection === "none"
      ? candidate.selectionDirection
      : undefined;

  return {
    element: element as SelectionControl,
    start: candidate.selectionStart,
    end: candidate.selectionEnd,
    direction,
  };
}

function captureDocumentSelection(documentRef: Document): Range[] | null {
  if (typeof documentRef.getSelection !== "function") return null;

  try {
    const selection = documentRef.getSelection();
    if (!selection) return null;

    const ranges: Range[] = [];
    for (let index = 0; index < selection.rangeCount; index += 1) {
      ranges.push(selection.getRangeAt(index).cloneRange());
    }
    return ranges;
  } catch {
    return null;
  }
}

function restoreFocusAndSelection(
  documentRef: Document,
  activeElement: Element | null,
  controlSelection: SavedControlSelection | null,
  documentRanges: Range[] | null,
): void {
  if (isFocusableElement(activeElement)) {
    try {
      activeElement.focus({ preventScroll: true });
    } catch {
      try {
        activeElement.focus();
      } catch {
        // A removed or disabled element can no longer accept focus.
      }
    }
  }

  if (controlSelection) {
    try {
      controlSelection.element.setSelectionRange(
        controlSelection.start,
        controlSelection.end,
        controlSelection.direction,
      );
    } catch {
      // The focused control may have been removed or changed while copying.
    }
  }

  if (documentRanges !== null && typeof documentRef.getSelection === "function") {
    try {
      const selection = documentRef.getSelection();
      if (!selection) return;

      selection.removeAllRanges();
      for (const range of documentRanges) selection.addRange(range);
    } catch {
      // A captured range may no longer belong to the live document.
    }
  }
}

function copyTextWithCompatibility(text: string): CompatibilityCopyResult {
  if (
    typeof document === "undefined" ||
    !document.body ||
    typeof document.createElement !== "function" ||
    typeof document.execCommand !== "function"
  ) {
    return { supported: false, copied: false };
  }

  const documentRef = document;
  const activeElement = documentRef.activeElement;
  const controlSelection = captureControlSelection(activeElement);
  const documentRanges = captureDocumentSelection(documentRef);
  let textarea: HTMLTextAreaElement | null = null;

  try {
    textarea = documentRef.createElement("textarea");
    textarea.value = text;
    textarea.readOnly = true;
    textarea.tabIndex = -1;
    textarea.setAttribute("aria-hidden", "true");
    textarea.setAttribute("readonly", "");

    Object.assign(textarea.style, {
      position: "fixed",
      top: "0",
      left: "-9999px",
      width: "1px",
      height: "1px",
      padding: "0",
      border: "0",
      opacity: "0",
      pointerEvents: "none",
    });

    documentRef.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, text.length);

    return {
      supported: true,
      copied: documentRef.execCommand("copy") === true,
    };
  } catch {
    return { supported: true, copied: false };
  } finally {
    if (textarea?.parentNode) textarea.parentNode.removeChild(textarea);
    restoreFocusAndSelection(
      documentRef,
      activeElement,
      controlSelection,
      documentRanges,
    );
  }
}

/**
 * Copies text from a direct user action without assuming a secure deployment.
 * The compatibility path is deliberately best-effort because execCommand is a
 * legacy browser API; callers must provide manual-copy recovery when `ok` is
 * false.
 */
export async function copyText(text: string): Promise<CopyTextResult> {
  let modernCopyAttempted = false;

  if (
    typeof window !== "undefined" &&
    window.isSecureContext === true &&
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.writeText === "function"
  ) {
    modernCopyAttempted = true;
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true, method: "clipboard" };
    } catch {
      // Permission and policy failures fall through to the compatibility path.
    }
  }

  const compatibility = copyTextWithCompatibility(text);
  if (compatibility.copied) {
    return { ok: true, method: "compatibility" };
  }

  return {
    ok: false,
    reason:
      modernCopyAttempted || compatibility.supported
        ? "copy_failed"
        : "unsupported",
  };
}
