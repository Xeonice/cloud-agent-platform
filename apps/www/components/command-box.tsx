"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * `<CommandBox>` — a monospace command block with copy-to-clipboard for the
 * marketing site (`@cap/www`), used by the Hero to present the `curl | sh`
 * one-line installer (task 2.2; design.md D4).
 *
 * The command renders in Geist Mono inside a hairline-bordered surface. The
 * copy control is an icon button that carries an accessible label, shows a
 * visible focus ring and `cursor-pointer`, and flips to a "copied" affordance
 * for ~2s after a successful copy. Copying degrades gracefully: it uses the
 * async Clipboard API when available and falls back to `execCommand('copy')`
 * for non-secure contexts.
 *
 * The button announces its result via `aria-live` so assistive tech hears the
 * "copied" state change.
 */
export interface CommandBoxProps {
  /** The literal command text to display and copy. */
  command: string;
  /** Accessible label for the copy button (e.g. "Copy install command"). */
  copyLabel?: string;
  /** Visible/SR text shown after a successful copy (e.g. "Copied"). */
  copiedLabel?: string;
  /** Optional leading prompt glyph; pass `null` to hide it. */
  prompt?: React.ReactNode;
  className?: string;
}

async function copyText(text: string): Promise<boolean> {
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path
    }
  }
  if (typeof document === "undefined") return false;
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export function CommandBox({
  command,
  copyLabel = "Copy command",
  copiedLabel = "Copied",
  prompt = "$",
  className,
}: CommandBoxProps) {
  const [copied, setCopied] = React.useState(false);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );

  const onCopy = React.useCallback(async () => {
    const ok = await copyText(command);
    if (!ok) return;
    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), 2000);
  }, [command]);

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border border-hairline bg-surface px-4 py-3 transition-colors duration-200 hover:border-fg/25 focus-within:border-fg/30",
        className,
      )}
    >
      <code className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto font-mono text-sm text-fg">
        {prompt != null && (
          <span aria-hidden="true" className="select-none text-muted">
            {prompt}
          </span>
        )}
        <span className="whitespace-pre">{command}</span>
      </code>
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? copiedLabel : copyLabel}
        className={cn(
          "inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-hairline px-2.5 text-xs font-medium text-fg transition-colors hover:bg-fg/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        )}
      >
        {copied ? (
          <CheckIcon className="h-3.5 w-3.5" />
        ) : (
          <CopyIcon className="h-3.5 w-3.5" />
        )}
        <span>{copied ? copiedLabel : "Copy"}</span>
      </button>
      <span aria-live="polite" className="sr-only">
        {copied ? copiedLabel : ""}
      </span>
    </div>
  );
}

function CopyIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
