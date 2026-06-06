/**
 * `SystemTile` / `SystemStrip` — the 3-up summary strip at the top of the
 * `/settings` content column (rebuild-console-tanstack-start Track 14).
 *
 * The prototype `.settings-system-strip`: three white `.system-tile`s
 * (`<span>LABEL</span><strong>value</strong><p>copy</p>`) summarizing the three
 * concerns the page manages — ACCOUNT / CREDENTIAL / SAFETY. Presentation only;
 * the ACCOUNT value (the allowlisted login) is passed in by the page from
 * `settingsQuery().allowedAccount`, never hardcoded.
 *
 * SSR-safe: pure render.
 *
 * Fidelity (`.system-tile` FINAL): white card, radius 8, card shadow, 14px
 * padding; LABEL = mono 12 tabular muted; value = ink clamp(19-26)/600/-0.6px;
 * copy = muted 13/1.5. Strip = `repeat(3, minmax(0,1fr))`, 10px gap; collapses to
 * 1 col <620px (`.console-body` responsive rule).
 */
import * as React from "react";

import { cn } from "@/utils";

/** One system summary tile (`<span>LABEL</span><strong/><p/>`). */
export interface SystemTileProps {
  /** Mono uppercase label (e.g. "ACCOUNT"). */
  label: React.ReactNode;
  /** The big value line (e.g. the allowlisted login). */
  value: React.ReactNode;
  /** Supporting copy (verbatim prototype). */
  copy: React.ReactNode;
}

/** A single `.system-tile`. */
export function SystemTile({ label, value, copy }: SystemTileProps) {
  return (
    <article className="min-w-0 rounded-md bg-card p-3.5 shadow-card">
      <span className="block font-mono text-xs tabular-nums text-muted-foreground">
        {label}
      </span>
      <strong className="mt-2 block text-[clamp(19px,2vw,26px)] font-semibold leading-[1.15] tracking-[-0.6px] text-foreground">
        {value}
      </strong>
      <p className="mt-2 text-[13px] leading-[1.5] text-muted-foreground">
        {copy}
      </p>
    </article>
  );
}

/** The 3-up summary strip wrapping the system tiles. */
export function SystemStrip({ children }: { children: React.ReactNode }) {
  return (
    <section
      aria-label="设置摘要"
      className={cn(
        "grid gap-2.5",
        "grid-cols-3 max-[620px]:grid-cols-1",
      )}
    >
      {children}
    </section>
  );
}
