/**
 * `TerminalFallback` — the no-xterm DOM line-view (task 18.3).
 *
 * Rendered when the @cap/ui `<Terminal>` is unavailable on the client (its
 * dynamic xterm import threw, OR `onReady` never fired within a short
 * client-side timeout). It reproduces the prototype's `.terminal-body`
 * line-view (`.terminal-line` with dim/ok/warn tints) plus the SAME command
 * row, so the page degrades instead of crashing.
 *
 * HONESTY: real WS streaming pends the aio-execution-hardening merge, so the
 * lines here are explicit connecting / awaiting-stream notices — NOT fabricated
 * command output. The lines are passed in by the parent so the connection state
 * can be reflected truthfully.
 *
 * SSR-safe: pure render off props. (It is only ever mounted client-side once
 * availability has been determined, but it touches no window APIs regardless.)
 */
import * as React from "react";

import { cn } from "@/utils";

/** Tint of a single fallback line, mirroring `.terminal-line.{dim,ok,warn,err}`. */
export type FallbackLineTone = "default" | "dim" | "ok" | "warn" | "err";

export interface FallbackLine {
  text: string;
  tone?: FallbackLineTone;
}

const TONE_CLASS: Record<FallbackLineTone, string> = {
  default: "text-terminal-fg",
  dim: "text-terminal-muted",
  ok: "text-terminal-ok",
  warn: "text-terminal-warn",
  err: "text-terminal-err",
};

export interface TerminalFallbackProps {
  lines: readonly FallbackLine[];
}

export function TerminalFallback({
  lines,
}: TerminalFallbackProps): React.ReactElement {
  return (
    <div
      data-terminal-fallback
      className="min-h-[min(680px,calc(100vh-348px))] overflow-auto whitespace-pre-wrap bg-[#050505] p-4 font-mono text-[13px] leading-[1.6]"
    >
      {lines.map((line, index) => (
        <span
          // Fallback lines are a fixed, ordered notice list; index is a stable key.
          key={index}
          className={cn("block", TONE_CLASS[line.tone ?? "default"])}
        >
          {line.text}
        </span>
      ))}
    </div>
  );
}
