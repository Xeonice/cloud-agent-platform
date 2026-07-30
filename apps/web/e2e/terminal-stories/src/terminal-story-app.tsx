import * as React from "react";
import type { ITheme } from "@xterm/xterm";
import {
  Terminal,
  type TerminalGeometry,
  type TerminalHandle,
  type TerminalResponseProfileRuntimeInputs,
} from "@cap-console/ui";

import {
  runTerminalStoryFixture,
  type FixtureProgress,
} from "./terminal-fixtures";
import {
  SessionTerminal,
  type ConnectionState,
  type SessionTerminalHandle,
} from "../../../src/components/session/session-terminal";
import { SessionCastLog } from "../../../src/components/session/session-cast-log";
import {
  installSessionMatrixWebSocket,
  type SessionMatrixRole,
  type SessionMatrixScenario,
  type SessionMatrixSocketProbe,
} from "./session-matrix-websocket";

type StoryKind =
  | "bare"
  | "session"
  | "responses"
  | "native"
  | "cast-disabled";

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
  if (
    raw === "session" ||
    raw === "responses" ||
    raw === "native" ||
    raw === "cast-disabled"
  ) {
    return raw;
  }
  return "bare";
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
  if (story === "responses") return <ResponseConformanceStory />;
  if (story === "native") return <NativeSessionMatrixStory />;
  if (story === "cast-disabled") return <DisabledCastStory />;
  return story === "session" ? <SessionShellStory /> : <BareTerminalStory />;
}

function DisabledCastStory(): React.ReactElement {
  return (
    <main className="terminal-story-page">
      <header className="terminal-story-header">
        <div>
          <p className="terminal-story-eyebrow">finished terminal capacity boundary</p>
          <h1>Default raw terminal history is disabled</h1>
        </div>
      </header>
      <section
        className="terminal-story-session-slot"
        data-testid="cast-disabled-story"
      >
        <SessionCastLog taskId="terminal-story-disabled-cast" />
      </section>
    </main>
  );
}

interface ResponseCaseProbe {
  readonly data: string[];
  readonly binary: string[];
}

interface ResponseProbe {
  readonly ready: boolean;
  readonly cases: Readonly<Record<string, ResponseCaseProbe>>;
  readonly enabledWindowCases: Readonly<Record<string, ResponseCaseProbe>>;
  readonly mouse: ResponseCaseProbe;
  readonly productionProfile: TerminalResponseProfileRuntimeInputs | null;
  readonly enabledWindowProfile: TerminalResponseProfileRuntimeInputs | null;
  readonly productionGeometry: TerminalGeometry | null;
  readonly enabledWindowGeometry: TerminalGeometry | null;
  readonly nativeState: {
    readonly buffer: ReturnType<TerminalHandle["bufferState"]>;
    readonly serialized: string;
  } | null;
  readonly normalStateAfterExit: {
    readonly buffer: ReturnType<TerminalHandle["bufferState"]>;
    readonly serialized: string;
  } | null;
}

const RESPONSE_QUERIES = [
  ["da1-7bit", "\x1b[c"],
  ["da1-c1", "\x9bc"],
  ["da2", "\x1b[>c"],
  ["da2-c1", "\x9b>c"],
  ["dsr", "\x1b[5n"],
  ["cpr", "\x1b[6n"],
  ["private-cpr", "\x1b[?6n"],
  ["decrqm-ansi-known", "\x1b[4$p"],
  ["decrqm-ansi-unknown", "\x1b[9999$p"],
  ["decrqm-private-known", "\x1b[?1$p"],
  ["decrqm-private-boundary", "\x1b[?999999$p"],
  ["decrqm-private-c1", "\x9b?2026$p"],
  ["decrqss-sgr", "\x1bP$qm\x1b\\"],
  ["decrqss-margins", "\x1bP$qr\x1b\\"],
  ["decrqss-cursor-style", "\x1bP$q q\x1b\\"],
  ["decrqss-protection", "\x1bP$q\"q\x1b\\"],
  ["decrqss-conformance", "\x1bP$q\"p\x1b\\"],
  ["decrqss-unknown", "\x1bP$qz\x1b\\"],
  ["decrqss-c1", "\x90$qm\x9c"],
  ["osc4-bel", "\x1b]4;0;?\x07"],
  ["osc4-st-boundary", "\x1b]4;255;?\x1b\\"],
  ["osc4-multiple", "\x1b]4;0;?;255;?\x1b\\"],
  ["osc10-bel", "\x1b]10;?\x07"],
  ["osc11-st", "\x1b]11;?\x1b\\"],
  ["osc12-c1", "\x9d12;?\x9c"],
  ["osc10-stacked-three", "\x1b]10;?;?;?\x1b\\"],
  ["window14-disabled", "\x1b[14t"],
  ["window16-disabled", "\x1b[16t"],
  ["window18-disabled", "\x1b[18t"],
] as const;

const ENABLED_WINDOW_QUERIES = [
  ["window14-enabled", "\x1b[14t"],
  ["window16-enabled-c1", "\x9b16t"],
  ["window18-enabled", "\x1b[18t"],
] as const;

const NATIVE_ALT_FRAME =
  "\x1b[?1049h\x1b[2J\x1b[H" +
  "\x1b[1;38;2;52;211;153mCAP_NATIVE_ALT_FRAME\x1b[0m" +
  "\x1b[2;5H中文光标样式状态" +
  "\x1b[4;12H\x1b[?25h";

function bytesHex(value: string): string {
  return [...value]
    .map((character) =>
      character.charCodeAt(0).toString(16).padStart(2, "0"),
    )
    .join("");
}

function ResponseConformanceStory(): React.ReactElement {
  const handleRef = React.useRef<TerminalHandle | null>(null);
  const enabledHandleRef = React.useRef<TerminalHandle | null>(null);
  const startedRef = React.useRef(false);
  const activeCaseRef = React.useRef<string | null>(null);
  const caseResultsRef = React.useRef<Record<string, ResponseCaseProbe>>({});
  const enabledCaseResultsRef = React.useRef<
    Record<string, ResponseCaseProbe>
  >({});
  const mouseDataRef = React.useRef<string[]>([]);
  const mouseBinaryRef = React.useRef<string[]>([]);
  const [theme, setTheme] = React.useState<ITheme | null>(null);
  const [probe, setProbe] = React.useState<ResponseProbe>({
    ready: false,
    cases: {},
    enabledWindowCases: {},
    mouse: { data: [], binary: [] },
    productionProfile: null,
    enabledWindowProfile: null,
    productionGeometry: null,
    enabledWindowGeometry: null,
    nativeState: null,
    normalStateAfterExit: null,
  });

  const publish = React.useCallback(
    (updates?: Partial<ResponseProbe>) => {
      setProbe((current) => ({
        ...current,
        ...updates,
        cases: { ...caseResultsRef.current },
        enabledWindowCases: { ...enabledCaseResultsRef.current },
        mouse: {
          data: [...mouseDataRef.current],
          binary: [...mouseBinaryRef.current],
        },
      }));
    },
    [],
  );

  React.useEffect(() => setTheme(terminalTheme()), []);

  const runMatrix = React.useCallback(
    async (
      handle: TerminalHandle,
      cases: readonly (readonly [string, string])[],
      target: React.MutableRefObject<Record<string, ResponseCaseProbe>>,
    ) => {
      for (const [name, query] of cases) {
        const data: string[] = [];
        const binary: string[] = [];
        target.current[name] = { data, binary };
        activeCaseRef.current = name;
        handle.reset();
        await new Promise<void>((resolve) => handle.write(query, resolve));
        await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
      }
      activeCaseRef.current = null;
    },
    [],
  );

  const startMatrices = React.useCallback(() => {
    const production = handleRef.current;
    const enabled = enabledHandleRef.current;
    if (!production || !enabled || startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      await runMatrix(production, RESPONSE_QUERIES, caseResultsRef);
      await runMatrix(enabled, ENABLED_WINDOW_QUERIES, enabledCaseResultsRef);

      production.reset();
      await new Promise<void>((resolve) =>
        production.write("NORMAL_BUFFER_SENTINEL", resolve),
      );
      await new Promise<void>((resolve) =>
        production.write(NATIVE_ALT_FRAME, resolve),
      );
      publish({
        ready: true,
        productionProfile: production.responseProfileInputs(),
        enabledWindowProfile: enabled.responseProfileInputs(),
        productionGeometry: production.geometry(),
        enabledWindowGeometry: enabled.geometry(),
        nativeState: {
          buffer: production.bufferState(),
          serialized: production.serialize() ?? "",
        },
      });
    })();
  }, [publish, runMatrix]);

  const record = React.useCallback(
    (channel: "data" | "binary", value: string) => {
      const activeCase = activeCaseRef.current;
      if (activeCase) {
        const result =
          caseResultsRef.current[activeCase] ??
          enabledCaseResultsRef.current[activeCase];
        if (result) {
          (channel === "data" ? result.data : result.binary).push(
            bytesHex(value),
          );
        }
      } else {
        (channel === "data" ? mouseDataRef.current : mouseBinaryRef.current).push(
          bytesHex(value),
        );
        publish();
      }
    },
    [publish],
  );

  const exitAlternateBuffer = React.useCallback(() => {
    const handle = handleRef.current;
    if (!handle) return;
    handle.write("\x1b[?1049l", () => {
      publish({
        normalStateAfterExit: {
          buffer: handle.bufferState(),
          serialized: handle.serialize() ?? "",
        },
      });
    });
  }, [publish]);

  return (
    <main className="terminal-story-page">
      <header className="terminal-story-header">
        <div>
          <p className="terminal-story-eyebrow">xterm source conformance</p>
          <h1>Production response profile</h1>
        </div>
        <a href="/?story=bare">Bare terminal story</a>
      </header>
      <section className="terminal-story-bare-frame" data-wide="true">
        <article className="terminal-story-terminal" data-testid="responses-terminal-article">
          <div className="terminal-story-terminal-head">
            <span>response-profile · xterm 5.5.0</span>
          </div>
          <div data-testid="terminal-story-body" className="terminal-story-terminal-body">
            {theme ? (
              <div className="terminal-story-response-grid">
                <div data-testid="responses-production-surface">
                  <Terminal
                    theme={theme}
                    className="terminal-story-xterm-host"
                    onReady={(handle) => {
                      handleRef.current = handle;
                      startMatrices();
                    }}
                    onData={(value) => record("data", value)}
                    onBinary={(value) => record("binary", value)}
                  />
                </div>
                <div data-testid="responses-enabled-window-surface">
                  <Terminal
                    theme={theme}
                    className="terminal-story-xterm-host"
                    windowOptions={{
                      getWinSizePixels: true,
                      getCellSizePixels: true,
                      getWinSizeChars: true,
                    }}
                    onReady={(handle) => {
                      enabledHandleRef.current = handle;
                      startMatrices();
                    }}
                    onData={(value) => record("data", value)}
                    onBinary={(value) => record("binary", value)}
                  />
                </div>
              </div>
            ) : null}
          </div>
          <div className="terminal-story-terminal-foot">
            <button
              type="button"
              data-testid="responses-mouse-sgr"
              onClick={() =>
                handleRef.current?.write("\x1b[?1000h\x1b[?1006h")
              }
            >
              SGR mouse
            </button>
            <button
              type="button"
              data-testid="responses-mouse-binary"
              onClick={() =>
                handleRef.current?.write("\x1b[?1006l\x1b[?1000h")
              }
            >
              binary mouse
            </button>
            <button
              type="button"
              data-testid="responses-exit-alt"
              onClick={exitAlternateBuffer}
            >
              exit alternate buffer
            </button>
          </div>
          <pre data-testid="responses-probe" className="terminal-story-probe">
            {JSON.stringify(probe)}
          </pre>
        </article>
      </section>
    </main>
  );
}

interface NativeSessionProbe {
  readonly scenario: SessionMatrixScenario;
  readonly mountKey: number;
  readonly connections: Readonly<Partial<Record<SessionMatrixRole, ConnectionState>>>;
  readonly screens: Readonly<Partial<Record<SessionMatrixRole, string>>>;
  readonly geometries: Readonly<
    Partial<Record<SessionMatrixRole, TerminalGeometry | null>>
  >;
  readonly socket: SessionMatrixSocketProbe | null;
}

function nativeScenario(): SessionMatrixScenario {
  const raw = new URLSearchParams(window.location.search).get("scenario");
  if (
    raw === "continuous" ||
    raw === "failed" ||
    raw === "profile" ||
    raw === "matrix"
  ) {
    return raw;
  }
  return "quiet";
}

function NativeSessionMatrixStory(): React.ReactElement {
  const [scenario] = React.useState<SessionMatrixScenario>(() => nativeScenario());
  const [installed, setInstalled] = React.useState(false);
  const [mountKey, setMountKey] = React.useState(0);
  const [compactRoles, setCompactRoles] = React.useState<
    Partial<Record<SessionMatrixRole, boolean>>
  >({});
  const handlesRef = React.useRef<
    Partial<Record<SessionMatrixRole, SessionTerminalHandle | null>>
  >({});
  const connectionRef = React.useRef<
    Partial<Record<SessionMatrixRole, ConnectionState>>
  >({});
  const [probe, setProbe] = React.useState<NativeSessionProbe>({
    scenario,
    mountKey: 0,
    connections: {},
    screens: {},
    geometries: {},
    socket: null,
  });

  React.useLayoutEffect(() => {
    const restore = installSessionMatrixWebSocket(scenario);
    setInstalled(true);
    return () => {
      setInstalled(false);
      restore();
    };
  }, [scenario]);

  React.useEffect(() => {
    const timer = window.setInterval(() => {
      const roles: readonly SessionMatrixRole[] = ["writer", "reader", "other"];
      setProbe({
        scenario,
        mountKey,
        connections: { ...connectionRef.current },
        screens: Object.fromEntries(
          roles.map((role) => [role, handlesRef.current[role]?.serialize() ?? ""]),
        ),
        geometries: Object.fromEntries(
          roles.map((role) => [role, handlesRef.current[role]?.geometry() ?? null]),
        ),
        socket: window.__capSessionMatrix?.probe() ?? null,
      });
    }, 50);
    return () => window.clearInterval(timer);
  }, [mountKey, scenario]);

  const resizeRole = React.useCallback((role: SessionMatrixRole) => {
    setCompactRoles((current) => ({
      ...current,
      [role]: !current[role],
    }));
    window.setTimeout(() => handlesRef.current[role]?.fit(), 80);
    window.setTimeout(() => handlesRef.current[role]?.fit(), 220);
  }, []);

  const terminal = (
    role: SessionMatrixRole,
    taskId: string,
  ): React.ReactElement => (
    <section
      key={`${role}:${mountKey}`}
      data-testid={`native-${role}-slot`}
      className="terminal-story-native-slot"
      data-compact={compactRoles[role] ? "true" : "false"}
    >
      <SessionTerminal
        ref={(handle) => {
          handlesRef.current[role] = handle;
        }}
        taskId={taskId}
        headLabel={`production SessionTerminal · ${role}`}
        phaseLabel={scenario}
        resourceLabel="finite gateway fixture"
        onConnectionChange={(state) => {
          connectionRef.current[role] = state;
        }}
      />
    </section>
  );

  return (
    <main className="terminal-story-page terminal-story-native-page">
      <header className="terminal-story-header">
        <div>
          <p className="terminal-story-eyebrow">production session conformance</p>
          <h1>Native SessionTerminal matrix · {scenario}</h1>
        </div>
        <div className="terminal-story-native-actions">
          <button
            type="button"
            data-testid="native-reconnect"
            onClick={() => setMountKey((value) => value + 1)}
          >
            reconnect
          </button>
          <button
            type="button"
            data-testid="native-resize-writer"
            onClick={() => resizeRole("writer")}
          >
            resize writer
          </button>
          <button
            type="button"
            data-testid="native-resize-reader"
            onClick={() => resizeRole("reader")}
          >
            resize reader
          </button>
        </div>
      </header>
      {installed ? (
        <div
          className="terminal-story-native-grid"
          data-matrix={scenario === "matrix" ? "true" : "false"}
        >
          {terminal("writer", "matrix-task-writer")}
          {scenario === "matrix"
            ? terminal("reader", "matrix-task-reader")
            : null}
          {scenario === "matrix"
            ? terminal("other", "matrix-other-task")
            : null}
        </div>
      ) : null}
      <pre data-testid="native-probe" className="terminal-story-probe">
        {JSON.stringify(probe)}
      </pre>
    </main>
  );
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
