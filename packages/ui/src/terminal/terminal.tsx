"use client";

import * as React from "react";
import type {
  Terminal as XTerm,
  IDisposable,
  ITheme,
  IWindowOptions,
} from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SerializeAddon } from "@xterm/addon-serialize";
import {
  PRODUCTION_TERMINAL_RESPONSE_PROFILE_INPUTS,
  TERMINAL_RESPONSE_WINDOW_OPTIONS,
  activateProductionTerminalResponseAddons,
  productionTerminalResponseAddonInputs,
  type TerminalResponseProfileRuntimeInputs,
  type TerminalResponseWindowOptions,
} from "./terminal-response-profile.js";

export type {
  TerminalResponseProfileRuntimeInputs,
  TerminalResponseWindowOptions,
} from "./terminal-response-profile.js";

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
  /** Fully reset parser modes, buffers, cursor state, and scrollback. */
  reset(): void;
  /** Re-fit the terminal to its container and report the new geometry. */
  fit(): TerminalGeometry | null;
  /** Measure the container's ideal fit without changing the terminal grid. */
  proposeFit(): TerminalGeometry | null;
  /**
   * Resize the terminal to an EXPLICIT geometry (cols × rows). Used by the
   * asciicast replay player to match the recording's geometry (header + `r`
   * events) so cursor-addressed redraws land correctly.
   */
  resize(cols: number, rows: number): void;
  /** Serialize both xterm buffers and modes via SerializeAddon. */
  serialize(): string | null;
  /**
   * Canonicalize only the active public xterm viewport. Unlike SerializeAddon,
   * this excludes the hidden normal-buffer shell used to attach an alternate-
   * screen TUI, while retaining every visible cell/style, cursor, mode, and the
   * authoritative geometry needed for strict fresh-attach comparisons.
   */
  activeBufferSnapshot(): string | null;
  /** Current geometry, or null before the terminal has mounted. */
  geometry(): TerminalGeometry | null;
  /** Current public xterm buffer identity and cursor, for diagnostics/stories. */
  bufferState(): {
    readonly type: "normal" | "alternate";
    readonly cursorX: number;
    readonly cursorY: number;
  } | null;
  /** Read back the response-affecting values of this mounted xterm instance. */
  responseProfileInputs(): TerminalResponseProfileRuntimeInputs;
  /** Clear the terminal screen and scrollback. */
  clear(): void;
  /**
   * Scroll the viewport to the very top of the scrollback (the start of the
   * session). Used by the static cast-log view, which bulk-writes the whole
   * recording and then lands the reader at the beginning of the history.
   */
  scrollToTop(): void;
  /**
   * Move the viewport to the bottom of the scrollback (the current live frame).
   * Used after reconnect replay so a refreshed live terminal lands on the latest
   * screen instead of briefly showing the replay fill position.
   */
  scrollToBottom(): void;
  /**
   * Force xterm to resync its internal scroll area with the buffer. Long,
   * paced writes can leave the DOM viewport height stale. When `preserveScroll`
   * is true, a user-scrolled history position is restored instead of snapping
   * back to the live bottom.
   */
  syncViewport(options?: { preserveScroll?: boolean }): void;
  /** Repaint the currently visible rows. */
  refresh(): void;
  /**
   * Move keyboard focus into the terminal (xterm's public `Terminal.focus()`,
   * which targets its hidden helper textarea). Scoped to THIS instance, so
   * consumers never reach for an unscoped `document.querySelector` on xterm's
   * internal class names.
   */
  focus(): void;
}

export interface TerminalProps {
  /**
   * Keystroke input callback. Receives raw input bytes as a string; the parent
   * forwards these through the write-lock to the PTY. When omitted the terminal
   * is read-only (a pure reader view).
   */
  onData?: (data: string) => void;
  /**
   * Binary input callback from xterm (legacy mouse and other byte protocols).
   * Each JS code unit represents one byte; consumers must use its low 8 bits.
   */
  onBinary?: (data: string) => void;
  /** Fires after the terminal has mounted, handing back the imperative handle. */
  onReady?: (handle: TerminalHandle) => void;
  /** Fires whenever the terminal is resized (initial fit + container resize). */
  onResize?: (geometry: TerminalGeometry) => void;
  /**
   * Reports the container's desired fit. In controlled-grid mode this does not
   * mutate xterm; the live session keeps the server-authoritative grid instead.
   */
  onFit?: (geometry: TerminalGeometry) => void;
  /** Keep resize-observer fits report-only after the initial mount fit. */
  controlledGrid?: boolean;
  /**
   * Explicit opt-in window reports. Production callers omit this and use the
   * all-disabled negotiated profile; conformance stories mount an isolated
   * enabled instance to characterize CSI 14/16/18.
   */
  windowOptions?: Partial<TerminalResponseWindowOptions>;
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
   * OPTIONAL scrollback line cap. Omitted ⇒ 10,000 (the live terminal's value).
   * The static cast-log view passes a larger cap so a long session's full
   * history is retained in scrollback rather than silently truncated.
   */
  scrollback?: number;
  /**
   * OPTIONAL CSS `font-family` for the terminal canvas. Omitted ⇒ the component
   * default monospace stack (the bare styleguide usage is unchanged). The
   * session page passes the resolved `--font-mono` stack ("JetBrains Mono" …)
   * so the live canvas matches the prototype's `.xterm-host`/`.terminal-body`.
   */
  fontFamily?: string;
}

function refreshVisibleRows(term: XTerm): void {
  try {
    term.refresh(0, Math.max(0, term.rows - 1));
  } catch {
    // Ignore renderer refresh failures during teardown.
  }
}

interface XTermWithPrivateViewport extends XTerm {
  _core?: {
    viewport?: {
      syncScrollArea?: (immediate?: boolean) => void;
    };
  };
}

function syncScrollArea(term: XTerm): void {
  try {
    (term as XTermWithPrivateViewport)._core?.viewport?.syncScrollArea?.(true);
  } catch {
    // Ignore private xterm viewport sync failures; refresh below is best-effort.
  }
  refreshVisibleRows(term);
}

export function Terminal({
  onData,
  onBinary,
  onReady,
  onResize,
  onFit,
  controlledGrid = false,
  windowOptions,
  className,
  theme,
  fontSize,
  lineHeight,
  fontFamily,
  scrollback,
}: TerminalProps): React.ReactElement {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const termRef = React.useRef<XTerm | null>(null);
  const fitRef = React.useRef<FitAddon | null>(null);
  const serializeRef = React.useRef<SerializeAddon | null>(null);

  // Keep the latest callbacks in refs so the mount effect runs exactly once
  // (xterm is expensive to re-instantiate) while always calling current props.
  const onDataRef = React.useRef(onData);
  const onBinaryRef = React.useRef(onBinary);
  const onReadyRef = React.useRef(onReady);
  const onResizeRef = React.useRef(onResize);
  const onFitRef = React.useRef(onFit);
  const controlledGridRef = React.useRef(controlledGrid);
  onDataRef.current = onData;
  onBinaryRef.current = onBinary;
  onReadyRef.current = onReady;
  onResizeRef.current = onResize;
  onFitRef.current = onFit;
  controlledGridRef.current = controlledGrid;

  // Appearance props are read once at mount (xterm is expensive to re-instantiate);
  // keeping them in refs avoids re-running the mount effect when the parent
  // re-renders with a freshly-resolved (but value-equal) theme object.
  const themeRef = React.useRef(theme);
  const fontSizeRef = React.useRef(fontSize);
  const lineHeightRef = React.useRef(lineHeight);
  const fontFamilyRef = React.useRef(fontFamily);
  const scrollbackRef = React.useRef(scrollback);
  const windowOptionsRef = React.useRef(windowOptions);
  themeRef.current = theme;
  fontSizeRef.current = fontSize;
  lineHeightRef.current = lineHeight;
  fontFamilyRef.current = fontFamily;
  scrollbackRef.current = scrollback;
  windowOptionsRef.current = windowOptions;

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
        // These response-affecting inputs are explicit because the negotiated
        // live-terminal profile fingerprints their exact production values.
        // Browser xterm 5.5.0 does not expose `termName` as a constructor option;
        // its resolved built-in value is the profiled `xterm` default.
        disableStdin:
          PRODUCTION_TERMINAL_RESPONSE_PROFILE_INPUTS.disableStdin,
        windowOptions: {
          ...TERMINAL_RESPONSE_WINDOW_OPTIONS,
          ...windowOptionsRef.current,
        } satisfies IWindowOptions,
        // Optional fontFamily — undefined falls back to the component's default
        // monospace stack, so the bare (family-less) usage is unchanged.
        fontFamily:
          fontFamilyRef.current ??
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
        fontSize: fontSizeRef.current ?? 13,
        scrollback: scrollbackRef.current ?? 10_000,
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
      activateProductionTerminalResponseAddons(term, unicode11Addon);

      term.open(container);
      try {
        fitAddon.fit();
      } catch {
        // Container may not be measurable yet; a later resize will fit.
      }
      const initialFit = fitAddon.proposeDimensions();
      if (initialFit) {
        onFitRef.current?.({ cols: initialFit.cols, rows: initialFit.rows });
      }

      termRef.current = term;
      fitRef.current = fitAddon;
      serializeRef.current = serializeAddon;

      disposables.push(
        term.onScroll(() => {
          syncScrollArea(term);
        }),
      );

      // Keystroke input → parent (forwarded through the write-lock upstream).
      disposables.push(
        term.onData((data) => {
          onDataRef.current?.(data);
        }),
      );

      // Binary xterm input must remain a byte string. Do not pass it through a
      // TextEncoder here; the session bridge owns the explicit low-8-bit map.
      disposables.push(
        term.onBinary((data) => {
          onBinaryRef.current?.(data);
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
          const proposed = fitAddon.proposeDimensions();
          if (proposed) {
            onFitRef.current?.({ cols: proposed.cols, rows: proposed.rows });
          }
          if (controlledGridRef.current) return;
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
        reset() {
          term.reset();
          term.clear();
        },
        fit() {
          try {
            fitAddon.fit();
          } catch {
            return null;
          }
          return { cols: term.cols, rows: term.rows };
        },
        proposeFit() {
          const geometry = fitAddon.proposeDimensions();
          return geometry ? { cols: geometry.cols, rows: geometry.rows } : null;
        },
        resize(cols, rows) {
          try {
            term.resize(cols, rows);
          } catch {
            // Ignore invalid geometry (xterm throws on non-positive dims).
          }
        },
        serialize() {
          try {
            return serializeAddon.serialize();
          } catch {
            return null;
          }
        },
        activeBufferSnapshot() {
          try {
            return serializeActiveBuffer(term);
          } catch {
            return null;
          }
        },
        geometry() {
          return { cols: term.cols, rows: term.rows };
        },
        bufferState() {
          const active = term.buffer.active;
          return {
            type: active.type,
            cursorX: active.cursorX,
            cursorY: active.cursorY,
          };
        },
        responseProfileInputs() {
          const resolvedWindowOptions = term.options.windowOptions ?? {};
          return {
            termName: PRODUCTION_TERMINAL_RESPONSE_PROFILE_INPUTS.termName,
            disableStdin: term.options.disableStdin ?? false,
            windowOptions: {
              getWinSizePixels: Boolean(resolvedWindowOptions.getWinSizePixels),
              getCellSizePixels: Boolean(resolvedWindowOptions.getCellSizePixels),
              getWinSizeChars: Boolean(resolvedWindowOptions.getWinSizeChars),
            },
            responseAffectingAddons: productionTerminalResponseAddonInputs(
              term.unicode.activeVersion,
            ),
          };
        },
        clear() {
          term.clear();
        },
        scrollToTop() {
          term.scrollToTop();
        },
        scrollToBottom() {
          term.scrollToBottom();
        },
        syncViewport(options) {
          const preserveScroll = options?.preserveScroll ?? false;
          const viewportY = term.buffer.active.viewportY;
          const wasAtBottom = viewportY >= term.buffer.active.baseY;
          syncScrollArea(term);
          if (preserveScroll && !wasAtBottom) {
            try {
              term.scrollToLine(viewportY);
            } catch {
              // Ignore stale viewport positions after a trim/resize race.
            }
          } else {
            term.scrollToBottom();
          }
          try {
            refreshVisibleRows(term);
          } catch {
            // Ignore renderer refresh failures during teardown.
          }
        },
        refresh() {
          refreshVisibleRows(term);
        },
        focus() {
          term.focus();
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

export type ActiveBufferSnapshotTerminal = Pick<
  XTerm,
  "buffer" | "cols" | "modes" | "rows"
>;

export function serializeActiveBuffer(
  term: ActiveBufferSnapshotTerminal,
): string {
  const buffer = term.buffer.active;
  const reusableCell = buffer.getNullCell();
  const rows = Array.from({ length: term.rows }, (_, row) => {
    const line = buffer.getLine(buffer.viewportY + row);
    if (!line) return { wrapped: false, cells: [] };
    const cells = Array.from({ length: term.cols }, (_, column) => {
      const cell = line.getCell(column, reusableCell);
      if (!cell) return null;
      const style =
        (cell.isBold() ? 1 : 0) |
        (cell.isItalic() ? 2 : 0) |
        (cell.isDim() ? 4 : 0) |
        (cell.isUnderline() ? 8 : 0) |
        (cell.isBlink() ? 16 : 0) |
        (cell.isInverse() ? 32 : 0) |
        (cell.isInvisible() ? 64 : 0) |
        (cell.isStrikethrough() ? 128 : 0) |
        (cell.isOverline() ? 256 : 0);
      return [
        cell.getChars(),
        cell.getCode(),
        cell.getWidth(),
        cell.getFgColorMode(),
        cell.getFgColor(),
        cell.getBgColorMode(),
        cell.getBgColor(),
        style,
      ];
    });
    return { wrapped: line.isWrapped, cells };
  });
  return JSON.stringify({
    version: 1,
    type: buffer.type,
    cols: term.cols,
    rows: term.rows,
    cursorX: buffer.cursorX,
    cursorY: buffer.baseY + buffer.cursorY - buffer.viewportY,
    atBottom: buffer.viewportY === buffer.baseY,
    modes: {
      applicationCursorKeysMode: term.modes.applicationCursorKeysMode,
      applicationKeypadMode: term.modes.applicationKeypadMode,
      bracketedPasteMode: term.modes.bracketedPasteMode,
      insertMode: term.modes.insertMode,
      mouseTrackingMode: term.modes.mouseTrackingMode,
      originMode: term.modes.originMode,
      reverseWraparoundMode: term.modes.reverseWraparoundMode,
      sendFocusMode: term.modes.sendFocusMode,
      wraparoundMode: term.modes.wraparoundMode,
    },
    viewport: rows,
  });
}
