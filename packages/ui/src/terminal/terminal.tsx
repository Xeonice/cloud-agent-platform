"use client";

import * as React from "react";
import type { Terminal as XTerm, IDisposable, ITheme } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SerializeAddon } from "@xterm/addon-serialize";

/**
 * `<Terminal>` — the shared xterm.js wrapper (frontend-console spec 13.2).
 *
 * Wraps an xterm.js terminal with the **fit**, **serialize**, and **unicode11**
 * addons configured (the three addons the spec requires). It exposes:
 *   - read-stream rendering: parent calls back into {@link TerminalHandle.write}
 *     to render raw PTY bytes, with an optional `onWriteFlushed` ack signal so
 *     the consumer can drive the ACK protocol (`term.write(chunk, callback)`),
 *   - a keystroke input callback (`onData`) the parent forwards through the
 *     write-lock.
 *
 * It is the single reusable terminal surface; `apps/web` mounts this rather than
 * instantiating xterm itself. xterm is imported lazily inside an effect so the
 * component is SSR-safe under Next.js (xterm touches `window`).
 */

/** Geometry of the underlying terminal, surfaced for snapshot/reconnect parity. */
export interface TerminalGeometry {
  cols: number;
  rows: number;
}

/** Imperative handle the session page drives the terminal through. */
export interface TerminalHandle {
  /**
   * Write raw decoded PTY output to the terminal. The optional callback fires
   * once xterm has flushed the chunk to the renderer, which the consumer uses
   * to advance the ACK counter (`term.write(chunk, callback)`).
   */
  write(data: string | Uint8Array, onFlushed?: () => void): void;
  /** Re-fit the terminal to its container and report the new geometry. */
  fit(): TerminalGeometry | null;
  /** Serialize the current visible frame (SerializeAddon) for snapshotting. */
  serialize(): string | null;
  /** Current geometry, or null before the terminal has mounted. */
  geometry(): TerminalGeometry | null;
  /** Clear the terminal screen and scrollback. */
  clear(): void;
}

export interface TerminalProps {
  /**
   * Keystroke input callback. Receives raw input bytes as a string; the parent
   * forwards these through the write-lock to the PTY. When omitted the terminal
   * is read-only (a pure reader view).
   */
  onData?: (data: string) => void;
  /** Fires after the terminal has mounted, handing back the imperative handle. */
  onReady?: (handle: TerminalHandle) => void;
  /** Fires whenever the terminal is resized (initial fit + container resize). */
  onResize?: (geometry: TerminalGeometry) => void;
  /** Extra className for the mount container. */
  className?: string;
  /**
   * OPTIONAL xterm color theme (background / foreground / cursor …) forwarded
   * verbatim into the underlying `new Terminal({ theme })`. Omitted ⇒ xterm's
   * default theme (the bare styleguide usage keeps working unchanged). The
   * session page resolves its `--terminal-*` CSS variables to hex client-side
   * and passes them here so the surface matches the design's dark terminal.
   */
  theme?: ITheme;
  /** OPTIONAL font size (px). Omitted ⇒ the component default (13). */
  fontSize?: number;
  /** OPTIONAL line height (multiplier). Omitted ⇒ xterm's default. */
  lineHeight?: number;
  /**
   * OPTIONAL CSS `font-family` for the terminal canvas. Omitted ⇒ the component
   * default monospace stack (the bare styleguide usage is unchanged). The
   * session page passes the resolved `--font-mono` stack ("JetBrains Mono" …)
   * so the live canvas matches the prototype's `.xterm-host`/`.terminal-body`.
   */
  fontFamily?: string;
}

export function Terminal({
  onData,
  onReady,
  onResize,
  className,
  theme,
  fontSize,
  lineHeight,
  fontFamily,
}: TerminalProps): React.ReactElement {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const termRef = React.useRef<XTerm | null>(null);
  const fitRef = React.useRef<FitAddon | null>(null);
  const serializeRef = React.useRef<SerializeAddon | null>(null);

  // Keep the latest callbacks in refs so the mount effect runs exactly once
  // (xterm is expensive to re-instantiate) while always calling current props.
  const onDataRef = React.useRef(onData);
  const onReadyRef = React.useRef(onReady);
  const onResizeRef = React.useRef(onResize);
  onDataRef.current = onData;
  onReadyRef.current = onReady;
  onResizeRef.current = onResize;

  // Appearance props are read once at mount (xterm is expensive to re-instantiate);
  // keeping them in refs avoids re-running the mount effect when the parent
  // re-renders with a freshly-resolved (but value-equal) theme object.
  const themeRef = React.useRef(theme);
  const fontSizeRef = React.useRef(fontSize);
  const lineHeightRef = React.useRef(lineHeight);
  const fontFamilyRef = React.useRef(fontFamily);
  themeRef.current = theme;
  fontSizeRef.current = fontSize;
  lineHeightRef.current = lineHeight;
  fontFamilyRef.current = fontFamily;

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    const disposables: IDisposable[] = [];
    let resizeObserver: ResizeObserver | null = null;

    void (async () => {
      // Lazy-load xterm + addons so this module is import-safe on the server.
      const [
        { Terminal: XTermCtor },
        { FitAddon },
        { SerializeAddon },
        { Unicode11Addon },
      ] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-serialize"),
        import("@xterm/addon-unicode11"),
      ]);
      if (disposed) return;

      const term = new XTermCtor({
        convertEol: false,
        cursorBlink: true,
        // Optional fontFamily — undefined falls back to the component's default
        // monospace stack, so the bare (family-less) usage is unchanged.
        fontFamily:
          fontFamilyRef.current ??
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
        fontSize: fontSizeRef.current ?? 13,
        scrollback: 10_000,
        allowProposedApi: true,
        // Optional appearance props — undefined falls back to xterm's defaults,
        // so the bare (theme-less) usage is unchanged.
        ...(themeRef.current ? { theme: themeRef.current } : {}),
        ...(lineHeightRef.current !== undefined
          ? { lineHeight: lineHeightRef.current }
          : {}),
      });

      const fitAddon = new FitAddon();
      const serializeAddon = new SerializeAddon();
      const unicode11Addon = new Unicode11Addon();

      term.loadAddon(fitAddon);
      term.loadAddon(serializeAddon);
      term.loadAddon(unicode11Addon);
      // Activate unicode v11 width handling once its addon is loaded.
      term.unicode.activeVersion = "11";

      term.open(container);
      try {
        fitAddon.fit();
      } catch {
        // Container may not be measurable yet; a later resize will fit.
      }

      termRef.current = term;
      fitRef.current = fitAddon;
      serializeRef.current = serializeAddon;

      // Keystroke input → parent (forwarded through the write-lock upstream).
      disposables.push(
        term.onData((data) => {
          onDataRef.current?.(data);
        }),
      );

      // Surface geometry changes for snapshot/reconnect parity.
      disposables.push(
        term.onResize(({ cols, rows }) => {
          onResizeRef.current?.({ cols, rows });
        }),
      );

      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => {
          try {
            fitAddon.fit();
          } catch {
            // Ignore transient unmeasurable states.
          }
        });
        resizeObserver.observe(container);
      }

      const handle: TerminalHandle = {
        write(data, onFlushed) {
          if (onFlushed) term.write(data, onFlushed);
          else term.write(data);
        },
        fit() {
          try {
            fitAddon.fit();
          } catch {
            return null;
          }
          return { cols: term.cols, rows: term.rows };
        },
        serialize() {
          try {
            return serializeAddon.serialize();
          } catch {
            return null;
          }
        },
        geometry() {
          return { cols: term.cols, rows: term.rows };
        },
        clear() {
          term.clear();
        },
      };

      onReadyRef.current?.(handle);
      onResizeRef.current?.({ cols: term.cols, rows: term.rows });
    })();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      for (const d of disposables) d.dispose();
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
      serializeRef.current = null;
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: "100%", height: "100%" }}
      data-testid="terminal-surface"
    />
  );
}
