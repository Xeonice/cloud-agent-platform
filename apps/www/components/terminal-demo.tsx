"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import type { TerminalDemoContent } from "../content";

/**
 * `<TerminalDemo>` — the Hero's showpiece: an animated, syntax-highlighted
 * terminal in a macOS window frame that "plays" the product story when it
 * scrolls into view (task 4.2).
 *
 * It re-implements the *concept* of the console's `RunnerCapsule` (a
 * window-chrome framed run preview) but with NO backend stream: the transcript
 * comes from the bilingual content module and is revealed client-side — prompt
 * lines are typed character-by-character, output/comment lines stream in as
 * blocks, a block caret tracks the cursor, and a "running" status dot pulses
 * while it plays. The playback covers the real narrative: a task leased to a
 * runner, the agent editing, the write gate pausing, and the operator approving.
 *
 * Look: the frame uses the macOS "traffic light" window controls (close/min/zoom
 * colours per the lwouis/macos-traffic-light-buttons-as-SVG approximation), and
 * the transcript is syntax-highlighted with a restrained One Dark palette
 * (text-term-* tokens in globals.css). The rest of the site stays monochrome —
 * the colour lives only here, as a depiction of a real terminal.
 *
 * Progressive enhancement + a11y:
 *  - The full transcript is server-rendered. Without JS, with reduced motion, or
 *    before the animation arms, it shows as a complete static (still
 *    highlighted) transcript — never a blank or partial one (good for no-JS/SEO).
 *  - When motion is allowed the animated transcript is `aria-hidden`, and an
 *    `sr-only` copy of the full transcript is exposed so assistive tech always
 *    reads the complete session, and never depends on colour for meaning.
 *  - `prefers-reduced-motion` is read in a layout effect (before paint) so the
 *    armed/streaming state is chosen without flashing the full transcript first.
 */
const KIND_CLASS: Record<TerminalDemoContent["lines"][number]["kind"], string> =
  {
    prompt: "text-fg",
    output: "text-muted",
    comment: "italic text-muted",
  };

const TYPE_MS = 42; // per-character cadence for typed prompt lines
const LEAD_IN_MS = 360; // beat before the first line starts
const AFTER_PROMPT_MS = 460; // pause after a command is "entered", before output
const AFTER_OUTPUT_MS = 260; // pause after an output/comment line lands

// macOS window controls (close / minimize / zoom) — fill + slightly darker rim,
// per the lwouis/macos-traffic-light-buttons-as-SVG approximation.
const TRAFFIC_LIGHTS = [
  { fill: "#ed6a5f", ring: "#e24b41" },
  { fill: "#f6be50", ring: "#e1a73e" },
  { fill: "#61c555", ring: "#2dac2f" },
] as const;

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect;

// ── tiny shell highlighter (no dependency; content is small and fixed) ───────
// Splits into quoted strings | whitespace | bare tokens, then colours each:
// first token = command, second bare word = sub-command, `-x` = flag, digits =
// number, quoted = string. Works on partially-typed text (unterminated quote).
const SHELL_TOKEN_RE = /("(?:[^"\\]|\\.)*"?)|(\s+)|([^\s]+)/g;

function renderShell(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let match: RegExpExecArray | null;
  let wordIndex = 0;
  let key = 0;
  SHELL_TOKEN_RE.lastIndex = 0;
  while ((match = SHELL_TOKEN_RE.exec(text)) !== null) {
    const [, str, ws, word] = match;
    if (ws != null) {
      nodes.push(ws);
      continue;
    }
    if (str != null) {
      nodes.push(
        <span key={key++} className="text-term-str">
          {str}
        </span>,
      );
      continue;
    }
    if (word != null) {
      const index = wordIndex++;
      let className = "text-fg";
      if (index === 0) className = "text-term-cmd";
      else if (word.startsWith("-")) className = "text-term-flag";
      else if (/^\d/.test(word)) className = "text-term-num";
      else if (index === 1 && /^[a-z][\w-]*$/i.test(word))
        className = "text-term-kw";
      nodes.push(
        <span key={key++} className={className}>
          {word}
        </span>,
      );
    }
  }
  return nodes;
}

const OUTPUT_TOKEN_RE = /(\s+)|([^\s]+)/g;

function renderOutput(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let key = 0;
  let rest = text;
  // Leading status glyph(s): ✓ = success (green), ● / others = command accent.
  const lead = rest.match(/^([●○✓✗•]+)(\s*)/u);
  if (lead) {
    const glyph = lead[1] ?? "";
    const ok = glyph.includes("✓");
    nodes.push(
      <span key={key++} className={ok ? "text-term-ok" : "text-term-cmd"}>
        {glyph}
      </span>,
    );
    if (lead[2]) nodes.push(lead[2]);
    rest = rest.slice(lead[0].length);
  }
  let match: RegExpExecArray | null;
  OUTPUT_TOKEN_RE.lastIndex = 0;
  while ((match = OUTPUT_TOKEN_RE.exec(rest)) !== null) {
    const [, ws, word] = match;
    if (ws != null) {
      nodes.push(ws);
      continue;
    }
    if (word != null) {
      let className = "text-muted";
      if (/^\d+$/.test(word)) className = "text-term-num";
      else if (word.includes("/") || /\.[a-z0-9]+$/i.test(word))
        className = "text-term-path";
      nodes.push(
        <span key={key++} className={className}>
          {word}
        </span>,
      );
    }
  }
  return nodes;
}

function renderBody(
  kind: TerminalDemoContent["lines"][number]["kind"],
  text: string,
): React.ReactNode {
  if (kind === "prompt") return renderShell(text);
  if (kind === "output") return renderOutput(text);
  return text; // comment — rendered as-is in the muted/italic line colour
}

export function TerminalDemo({
  caption,
  lines,
  className,
}: TerminalDemoContent & { className?: string }) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  // `armed` = the JS-driven animation is active (motion allowed + mounted).
  const [armed, setArmed] = React.useState(false);
  const [started, setStarted] = React.useState(false);
  const [done, setDone] = React.useState(false);
  // Reveal cursor: `shown` fully-revealed lines + `typing` chars of line[shown].
  const [shown, setShown] = React.useState(0);
  const [typing, setTyping] = React.useState(0);

  // Decide armed/static BEFORE paint so motion users never see the full
  // transcript flash in, then collapse to the streaming start.
  useIsomorphicLayoutEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      setShown(0);
      setTyping(0);
      setDone(false);
      setStarted(false);
      setArmed(!mq.matches);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // Begin playback when the terminal scrolls into view (once).
  React.useEffect(() => {
    if (!armed || started) return;
    const node = containerRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setStarted(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setStarted(true);
            observer.disconnect();
            break;
          }
        }
      },
      { threshold: 0.35 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [armed, started]);

  // The stream scheduler: types prompts char-by-char, reveals outputs as blocks.
  React.useEffect(() => {
    if (!armed || !started || done) return;
    let line = 0;
    let char = 0;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      const current = lines[line];
      if (!current) {
        setShown(lines.length);
        setTyping(0);
        setDone(true);
        return;
      }
      if (current.kind === "prompt" && char < current.text.length) {
        char += 1;
        setShown(line);
        setTyping(char);
        timer = setTimeout(step, TYPE_MS);
        return;
      }
      const pause =
        current.kind === "prompt" ? AFTER_PROMPT_MS : AFTER_OUTPUT_MS;
      line += 1;
      char = 0;
      setShown(line);
      setTyping(0);
      timer = setTimeout(step, pause);
    };
    timer = setTimeout(step, LEAD_IN_MS);
    return () => clearTimeout(timer);
  }, [armed, started, done, lines]);

  const isPlaying = armed && started && !done;

  return (
    <div
      ref={containerRef}
      className={cn(
        "overflow-hidden rounded-xl border border-hairline bg-surface shadow-2xl shadow-black/40",
        className,
      )}
    >
      {/* macOS window chrome + run status */}
      <div className="flex items-center gap-3 border-b border-hairline bg-white/[0.02] px-4 py-2.5">
        <span aria-hidden="true" className="flex items-center gap-2">
          {TRAFFIC_LIGHTS.map((light, index) => (
            <span
              key={index}
              className="h-3 w-3 rounded-full"
              style={{
                backgroundColor: light.fill,
                boxShadow: `inset 0 0 0 0.5px ${light.ring}`,
              }}
            />
          ))}
        </span>
        <span className="flex min-w-0 items-center gap-2 font-mono text-xs text-muted">
          {armed ? (
            <span
              aria-hidden="true"
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                isPlaying ? "animate-status bg-term-ok" : "bg-fg/40",
              )}
            />
          ) : null}
          <span className="truncate">{caption}</span>
        </span>
      </div>

      {/* animated transcript (visual). When armed it is aria-hidden and an
          sr-only full transcript below carries the text for assistive tech. */}
      <div
        className="overflow-x-auto p-4"
        aria-hidden={armed ? "true" : undefined}
      >
        <pre className="font-mono text-[13px] leading-relaxed">
          <code>
            {lines.map((line, index) => {
              const current = armed && !done && index === shown;
              const visible = !armed || done || index <= shown;
              const text =
                current && line.kind === "prompt"
                  ? line.text.slice(0, typing)
                  : line.text;
              const showCaret = armed
                ? done
                  ? index === lines.length - 1
                  : index === shown
                : false;
              return (
                <span
                  key={index}
                  className={cn(
                    "block transition-opacity duration-300",
                    KIND_CLASS[line.kind],
                    visible ? "opacity-100" : "opacity-0",
                  )}
                >
                  {line.kind === "prompt" && (
                    <span aria-hidden="true" className="select-none text-term-ok">
                      {"$ "}
                    </span>
                  )}
                  {renderBody(line.kind, text)}
                  {showCaret && (
                    <span
                      aria-hidden="true"
                      className="ml-0.5 inline-block h-[1em] w-[0.55em] translate-y-[0.12em] rounded-[1px] bg-fg/80 animate-caret"
                    />
                  )}
                </span>
              );
            })}
          </code>
        </pre>
      </div>

      {armed ? (
        <div className="sr-only">
          {lines.map((line, index) => (
            <div key={index}>{line.text}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
