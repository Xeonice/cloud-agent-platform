import * as React from "react";
import type { ITheme } from "@xterm/xterm";
import {
  Terminal,
  type TerminalGeometry,
  type TerminalHandle,
} from "@cap/ui";

import {
  runTerminalStoryFixture,
  type FixtureProgress,
} from "./terminal-fixtures";

type StoryKind = "bare" | "session";

interface StoryProbe {
  readonly geometry: TerminalGeometry | null;
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

const EMPTY_PROGRESS: FixtureProgress = {
  fixtureDone: false,
  liveAppendCount: 0,
  writeCount: 0,
};

function resolveVar(styles: CSSStyleDeclaration, name: string): string {
  return styles.getPropertyValue(name).trim();
}

function terminalTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const bg = resolveVar(styles, "--terminal-bg") || "#050505";
  const fg = resolveVar(styles, "--terminal-fg") || "#e8e8e8";
  const muted = resolveVar(styles, "--terminal-muted") || "#8a8a8a";
  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    selectionBackground: muted,
  };
}

function currentStory(): StoryKind {
  const raw = new URLSearchParams(window.location.search).get("story");
  return raw === "session" ? "session" : "bare";
}

function roundedBounds(el: Element | null): { width: number; height: number } | null {
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return {
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

export function TerminalStoryApp(): React.ReactElement {
  const [story] = React.useState<StoryKind>(() => currentStory());
  return story === "session" ? <SessionShellStory /> : <BareTerminalStory />;
}

function BareTerminalStory(): React.ReactElement {
  const [wide, setWide] = React.useState(true);
  return (
    <main className="terminal-story-page">
      <header className="terminal-story-header">
        <div>
          <p className="terminal-story-eyebrow">xterm story</p>
          <h1>Bare shared Terminal</h1>
        </div>
        <a href="/?story=session">Session shell story</a>
      </header>
      <section
        data-testid="bare-frame"
        className="terminal-story-bare-frame"
        data-wide={wide ? "true" : "false"}
      >
        <TerminalFixture
          story="bare"
          frame="bare"
          onToggleSize={() => setWide((value) => !value)}
        />
      </section>
    </main>
  );
}

function SessionShellStory(): React.ReactElement {
  return (
    <main data-testid="session-story-shell" className="terminal-story-session-shell">
      <header data-testid="session-story-header" className="terminal-story-session-header">
        <div>
          <p className="terminal-story-eyebrow">xterm story</p>
          <h1>Session height chain</h1>
        </div>
        <a href="/?story=bare">Bare terminal story</a>
      </header>
      <section data-testid="session-story-slot" className="terminal-story-session-slot">
        <TerminalFixture story="session" frame="session" />
      </section>
    </main>
  );
}

function TerminalFixture({
  story,
  frame,
  onToggleSize,
}: {
  story: StoryKind;
  frame: "bare" | "session";
  onToggleSize?: () => void;
}): React.ReactElement {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const handleRef = React.useRef<TerminalHandle | null>(null);
  const fixtureStartedRef = React.useRef(false);
  const progressRef = React.useRef<FixtureProgress>(EMPTY_PROGRESS);
  const resizeCountRef = React.useRef(0);
  const [theme, setTheme] = React.useState<ITheme | null>(null);
  const [geometry, setGeometry] = React.useState<TerminalGeometry | null>(null);
  const [probe, setProbe] = React.useState<StoryProbe>({
    geometry: null,
    resizeCount: 0,
    bounds: null,
    bodyBounds: null,
    viewport: null,
    visibleText: "",
    serialized: "",
    ...EMPTY_PROGRESS,
  });

  const refreshProbe = React.useCallback(() => {
    const host = hostRef.current;
    const handle = handleRef.current;
    const viewport = host?.querySelector(".xterm-viewport") as HTMLElement | null;
    const rows = host?.querySelector(".xterm-rows") as HTMLElement | null;
    const surface = host
      ? host.querySelector("[data-testid='terminal-surface']")
      : null;
    const body = host
      ? host.querySelector("[data-testid='terminal-story-body']")
      : null;
    const currentProgress = progressRef.current;
    setProbe({
      geometry: handle?.geometry() ?? geometry,
      resizeCount: resizeCountRef.current,
      bounds: roundedBounds(surface),
      bodyBounds: roundedBounds(body),
      viewport: viewport
        ? {
            scrollTop: Math.round(viewport.scrollTop),
            scrollHeight: Math.round(viewport.scrollHeight),
            clientHeight: Math.round(viewport.clientHeight),
          }
        : null,
      visibleText: rows?.textContent ?? "",
      serialized: handle?.serialize() ?? "",
      fixtureDone: currentProgress.fixtureDone,
      liveAppendCount: currentProgress.liveAppendCount,
      writeCount: currentProgress.writeCount,
    });
  }, [geometry]);

  React.useEffect(() => {
    setTheme(terminalTheme());
  }, []);

  React.useEffect(() => {
    const timer = window.setInterval(refreshProbe, 120);
    return () => window.clearInterval(timer);
  }, [refreshProbe]);

  const startFixture = React.useCallback((handle: TerminalHandle) => {
    if (fixtureStartedRef.current) return;
    fixtureStartedRef.current = true;
    void runTerminalStoryFixture(handle, (progress) => {
      progressRef.current = progress;
      refreshProbe();
    });
  }, [refreshProbe]);

  const scrollToTop = React.useCallback(() => {
    handleRef.current?.scrollToTop();
    window.setTimeout(refreshProbe, 60);
  }, [refreshProbe]);

  const scrollToBottom = React.useCallback(() => {
    handleRef.current?.scrollToBottom();
    window.setTimeout(refreshProbe, 60);
  }, [refreshProbe]);

  return (
    <article
      ref={hostRef}
      data-testid={`${story}-terminal-article`}
      className="terminal-story-terminal"
      data-frame={frame}
    >
      <div className="terminal-story-terminal-head">
        <span>{story === "session" ? "session-shell" : "bare-terminal"} · fixture</span>
        <span data-testid={`${story}-geometry-label`}>
          {geometry ? `${geometry.cols}x${geometry.rows}` : "pending"}
        </span>
      </div>
      <div data-testid="terminal-story-body" className="terminal-story-terminal-body">
        {theme ? (
          <Terminal
            theme={theme}
            fontSize={13}
            lineHeight={1.45}
            scrollback={2000}
            fontFamily={
              '"Geist Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'
            }
            className="terminal-story-xterm-host"
            onReady={(handle) => {
              handleRef.current = handle;
              setGeometry(handle.geometry());
              startFixture(handle);
              window.setTimeout(refreshProbe, 60);
            }}
            onResize={(nextGeometry) => {
              resizeCountRef.current += 1;
              setGeometry(nextGeometry);
              window.setTimeout(refreshProbe, 60);
            }}
          />
        ) : null}
      </div>
      <div className="terminal-story-terminal-foot">
        <button type="button" data-testid={`${story}-scroll-top`} onClick={scrollToTop}>
          scroll top
        </button>
        <button type="button" data-testid={`${story}-scroll-bottom`} onClick={scrollToBottom}>
          scroll bottom
        </button>
        {onToggleSize ? (
          <button type="button" data-testid={`${story}-toggle-size`} onClick={onToggleSize}>
            toggle size
          </button>
        ) : null}
        <span>resize events: {probe.resizeCount}</span>
      </div>
      <pre data-testid={`${story}-probe`} className="terminal-story-probe">
        {JSON.stringify(probe)}
      </pre>
      <pre data-testid={`${story}-serialized`} className="terminal-story-probe">
        {probe.serialized}
      </pre>
      <pre data-testid={`${story}-visible-text`} className="terminal-story-probe">
        {probe.visibleText}
      </pre>
    </article>
  );
}
