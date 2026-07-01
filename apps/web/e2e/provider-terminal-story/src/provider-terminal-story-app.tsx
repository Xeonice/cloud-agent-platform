import * as React from "react";

import {
  SessionTerminal,
  type SessionTerminalHandle,
} from "../../../src/components/session/session-terminal";
import { apiBaseUrl, operatorToken } from "../../../src/lib/config";
import {
  providerFixtureFromQuery,
  type ProviderTerminalFixture,
} from "./provider-terminal-fixtures";
import { installProviderFixtureWebSocket } from "./provider-fixture-websocket";

type RequestedProvider = "auto" | "aio" | "boxlite";
type SessionStatus = "running" | "tearing_down" | "torn_down";

interface Readiness {
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly requestedProvider: RequestedProvider;
  readonly configuredProvider: string;
  readonly providerId: string | null;
  readonly reason: string | null;
  readonly capabilities: readonly string[];
}

interface StorySession {
  readonly sessionId: string;
  readonly status: SessionStatus;
  readonly providerId: string;
  readonly requestedProvider: RequestedProvider;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly terminalPath: "/terminal";
  readonly teardownError?: string;
}

interface StoryProbe {
  readonly status: "idle" | "creating" | "running" | "tearing_down" | "error";
  readonly providerId: string | null;
  readonly sessionId: string | null;
  readonly readiness: Readiness | null;
  readonly teardownStatus: SessionStatus | null;
  readonly terminalText: string;
  readonly scrollTop: number | null;
  readonly scrollHeight: number | null;
  readonly clientHeight: number | null;
  readonly compact: boolean;
  readonly mountKey: number;
  readonly fixtureKind: string | null;
  readonly descriptor:
    | {
        readonly terminalProtocol: string;
        readonly commandProtocol: string;
        readonly workspaceMode: string;
        readonly retentionMode: string;
      }
    | null;
  readonly error: string | null;
}

function currentProvider(): RequestedProvider {
  const raw = new URLSearchParams(window.location.search).get("provider");
  return raw === "aio" || raw === "boxlite" ? raw : "auto";
}

function shouldAutostart(): boolean {
  return new URLSearchParams(window.location.search).get("autostart") === "1";
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers = { ...extra };
  const token = operatorToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    credentials: "include",
    headers: authHeaders(init?.headers as Record<string, string> | undefined),
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : undefined;
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "message" in body
        ? String((body as { message?: unknown }).message)
        : text || response.statusText;
    throw new Error(`HTTP ${response.status}: ${message}`);
  }
  return body as T;
}

function readTerminalText(): string {
  return document.querySelector(".xterm-rows")?.textContent ?? "";
}

function readViewport(): Pick<
  StoryProbe,
  "scrollTop" | "scrollHeight" | "clientHeight"
> {
  const viewport = document.querySelector(".xterm-viewport") as HTMLElement | null;
  return {
    scrollTop: viewport ? Math.round(viewport.scrollTop) : null,
    scrollHeight: viewport ? Math.round(viewport.scrollHeight) : null,
    clientHeight: viewport ? Math.round(viewport.clientHeight) : null,
  };
}

export function ProviderTerminalStoryApp(): React.ReactElement {
  const [provider] = React.useState<RequestedProvider>(() => currentProvider());
  const [autostart] = React.useState(() => shouldAutostart());
  const [fixture] = React.useState<ProviderTerminalFixture | null>(() =>
    providerFixtureFromQuery(),
  );
  const [readiness, setReadiness] = React.useState<Readiness | null>(null);
  const [session, setSession] = React.useState<StorySession | null>(null);
  const [status, setStatus] = React.useState<StoryProbe["status"]>("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [compact, setCompact] = React.useState(false);
  const [mountKey, setMountKey] = React.useState(0);
  const [probe, setProbe] = React.useState<StoryProbe>({
    status: "idle",
    providerId: null,
    sessionId: null,
    readiness: null,
    teardownStatus: null,
    terminalText: "",
    scrollTop: null,
    scrollHeight: null,
    clientHeight: null,
    compact: false,
    mountKey: 0,
    fixtureKind: null,
    descriptor: null,
    error: null,
  });
  const creatingRef = React.useRef(false);
  const terminalRef = React.useRef<SessionTerminalHandle | null>(null);

  const refreshReadiness = React.useCallback(async () => {
    if (fixture) {
      const next: Readiness = {
        enabled: true,
        ready: true,
        requestedProvider: fixture.kind,
        configuredProvider: fixture.providerId,
        providerId: fixture.providerId,
        reason: null,
        capabilities: [
          "terminal.websocket",
          "terminal.interactive",
          "command.exec",
        ],
      };
      setReadiness(next);
      return next;
    }
    const next = await requestJson<Readiness>(
      `/terminal-stories/provider?provider=${encodeURIComponent(provider)}`,
    );
    setReadiness(next);
    return next;
  }, [fixture, provider]);

  const createSession = React.useCallback(async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setStatus("creating");
    setError(null);
    try {
      if (fixture) {
        const created: StorySession = {
          sessionId: fixture.sessionId,
          status: "running",
          providerId: fixture.providerId,
          requestedProvider: fixture.kind,
          createdAt: "2026-06-30T00:00:00.000Z",
          expiresAt: "2026-06-30T00:10:00.000Z",
          terminalPath: "/terminal",
        };
        setSession(created);
        setMountKey((value) => value + 1);
        setStatus("running");
        return;
      }
      const created = await requestJson<StorySession>(
        "/terminal-stories/provider/sessions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider, ttlMs: 10 * 60_000 }),
        },
      );
      setSession(created);
      setMountKey((value) => value + 1);
      setStatus("running");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      creatingRef.current = false;
    }
  }, [fixture, provider]);

  const teardown = React.useCallback(async () => {
    if (!session) return;
    setStatus("tearing_down");
    setError(null);
    try {
      if (fixture) {
        setSession({ ...session, status: "torn_down" });
        setStatus("idle");
        return;
      }
      const tornDown = await requestJson<StorySession>(
        `/terminal-stories/provider/sessions/${encodeURIComponent(session.sessionId)}`,
        { method: "DELETE" },
      );
      setSession(tornDown);
      setStatus("idle");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [fixture, session]);

  React.useEffect(() => {
    let cancelled = false;
    void refreshReadiness()
      .then((next) => {
        if (!cancelled && autostart && next.enabled && next.ready) {
          void createSession();
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatus("error");
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [autostart, createSession, refreshReadiness]);

  React.useEffect(() => {
    const timer = window.setInterval(() => {
      setProbe({
        status,
        providerId: session?.providerId ?? readiness?.providerId ?? null,
        sessionId: session?.sessionId ?? null,
        readiness,
        teardownStatus: session?.status ?? null,
        terminalText: readTerminalText(),
        ...readViewport(),
        compact,
        mountKey,
        fixtureKind: fixture?.kind ?? null,
        descriptor: fixture
          ? {
              terminalProtocol: fixture.selectedRun.terminal.protocol,
              commandProtocol: fixture.selectedRun.command.protocol,
              workspaceMode: fixture.selectedRun.workspace.mode,
              retentionMode: fixture.selectedRun.retention.mode,
            }
          : null,
        error,
      });
    }, 150);
    return () => window.clearInterval(timer);
  }, [compact, error, fixture, mountKey, readiness, session, status]);

  const scrollTop = React.useCallback(() => {
    const viewport = document.querySelector(".xterm-viewport") as HTMLElement | null;
    if (viewport) viewport.scrollTop = 0;
  }, []);

  const scrollBottom = React.useCallback(() => {
    const viewport = document.querySelector(".xterm-viewport") as HTMLElement | null;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, []);

  const resizeTerminal = React.useCallback(() => {
    setCompact((value) => !value);
    window.setTimeout(() => terminalRef.current?.fit(), 80);
    window.setTimeout(() => terminalRef.current?.fit(), 240);
  }, []);

  const liveSession = session?.status === "running" ? session : null;

  return (
    <main className="provider-story-shell">
      <header className="provider-story-header">
        <div>
          <p>provider-backed terminal story</p>
          <h1>CAP terminal gateway</h1>
        </div>
        <div className="provider-story-actions">
          <button
            data-testid="provider-story-refresh"
            type="button"
            onClick={() => void refreshReadiness()}
          >
            refresh
          </button>
          <button
            data-testid="provider-story-create"
            type="button"
            onClick={() => void createSession()}
          >
            create
          </button>
          <button
            data-testid="provider-story-teardown"
            type="button"
            onClick={() => void teardown()}
            disabled={!session}
          >
            teardown
          </button>
          <button
            data-testid="provider-story-reconnect"
            type="button"
            onClick={() => setMountKey((value) => value + 1)}
            disabled={!liveSession}
          >
            reconnect
          </button>
          <button
            data-testid="provider-story-toggle-size"
            type="button"
            onClick={resizeTerminal}
          >
            resize
          </button>
        </div>
      </header>

      <section className="provider-story-meta" aria-label="Provider story status">
        <span data-testid="provider-story-readiness">
          {readiness
            ? readiness.enabled
              ? readiness.ready
                ? "ready"
                : "not-ready"
              : "not-enabled"
            : "loading"}
        </span>
        <span data-testid="provider-story-provider-id">
          {session?.providerId ?? readiness?.providerId ?? "none"}
        </span>
        <span data-testid="provider-story-session-id">
          {session?.sessionId ?? "none"}
        </span>
        <span data-testid="provider-story-teardown-status">
          {session?.status ?? "none"}
        </span>
        {readiness?.reason ? (
          <span data-testid="provider-story-readiness-reason">{readiness.reason}</span>
        ) : null}
        {error ? <span data-testid="provider-story-error">{error}</span> : null}
      </section>

      <section
        data-testid="provider-story-terminal-slot"
        className="provider-story-terminal-slot"
        data-compact={compact ? "true" : "false"}
      >
        {liveSession && fixture ? (
          <ProviderFixtureSessionTerminal
            key={`${liveSession.sessionId}:${mountKey}`}
            fixture={fixture}
            session={liveSession}
            terminalRef={terminalRef}
          />
        ) : liveSession ? (
          <SessionTerminal
            key={`${liveSession.sessionId}:${mountKey}`}
            ref={terminalRef}
            taskId={liveSession.sessionId}
            headLabel={`${liveSession.providerId} · ${liveSession.sessionId}`}
            phaseLabel="story"
            resourceLabel="provider fixture"
          />
        ) : (
          <div className="provider-story-empty" data-testid="provider-story-empty">
            {status}
          </div>
        )}
      </section>

      <footer className="provider-story-footer">
        <button data-testid="provider-story-scroll-top" type="button" onClick={scrollTop}>
          scroll top
        </button>
        <button
          data-testid="provider-story-scroll-bottom"
          type="button"
          onClick={scrollBottom}
        >
          scroll bottom
        </button>
      </footer>

      <pre data-testid="provider-story-probe" className="provider-story-probe">
        {JSON.stringify(probe)}
      </pre>
    </main>
  );
}

function ProviderFixtureSessionTerminal({
  fixture,
  session,
  terminalRef,
}: {
  fixture: ProviderTerminalFixture;
  session: StorySession;
  terminalRef: React.Ref<SessionTerminalHandle>;
}): React.ReactElement | null {
  const [installed, setInstalled] = React.useState(false);

  React.useLayoutEffect(() => {
    const restore = installProviderFixtureWebSocket(fixture);
    setInstalled(true);
    return () => {
      setInstalled(false);
      restore();
    };
  }, [fixture, session.sessionId]);

  if (!installed) return null;
  return (
    <SessionTerminal
      ref={terminalRef}
      taskId={session.sessionId}
      headLabel={`${fixture.providerId} · ${session.sessionId}`}
      phaseLabel="fixture"
      resourceLabel="provider fixture"
    />
  );
}
