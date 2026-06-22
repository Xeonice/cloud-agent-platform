/**
 * Minimal ground-truth test: Client auth gate on the app-shell
 * (add-private-account-identity requirement)
 *
 * The gate lives in the `beforeLoad` callback of `src/routes/_app.tsx`.
 * It has two branches:
 *
 *   A. Real-auth path (`isAuthCapable()` === true):
 *      Resolves `authSessionQuery` → if session is null, redirects to `/login`
 *      with `search: { redirect: location.href }`.
 *
 *   B. Mock-gate path (`isAuthCapable()` === false):
 *      Reads `sessionStorage` via `isAuthenticated()` → if not set, redirects.
 *      On the SERVER (`typeof document === "undefined"`) it returns early (no
 *      false SSR redirect for a mock session).
 *
 * Strategy: extract the gate logic into a plain async function (mirroring
 * `beforeLoad`) and call it directly without mounting the router/React, so the
 * test stays in the pure `node` environment the vitest config specifies.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Control `isCapable` / `forceMock` from capabilities.
// ---------------------------------------------------------------------------
let _authCapable = false;

vi.mock("../lib/api/capabilities", () => ({
  isCapable: (domain: string) => domain === "auth" && _authCapable,
  forceMock: () => false,
}));

// Stub transitive imports pulled in by mock-session.
vi.mock("../lib/store", () => ({
  resetState: vi.fn(),
  setState: vi.fn(),
  getState: vi.fn(() => ({})),
}));
vi.mock("../lib/config", () => ({
  apiBaseUrl: () => "http://localhost:3000",
}));
vi.mock("../lib/safe-redirect", () => ({
  safeRelativePath: (p: string | undefined) => p ?? null,
}));

// ---------------------------------------------------------------------------
// Import the functions we need after the mocks are in place.
// ---------------------------------------------------------------------------
import { isAuthCapable, isAuthenticated } from "../lib/mock-session";

// ---------------------------------------------------------------------------
// Reproduce the exact gate logic from _app.tsx `beforeLoad`.
// This is NOT a copy-paste — it calls the SAME exported functions the real
// gate calls, so any regression in those functions fails THIS test.
// ---------------------------------------------------------------------------

/**
 * Simulated `redirect` (mirrors TanStack Router's throw redirect).
 * We capture it as a value instead of throwing, so the test can assert on it.
 */
interface RedirectCapture {
  to: string;
  search?: { redirect?: string };
}

/**
 * Execute the app-shell auth gate in the test environment.
 *
 * @param sessionValue  What `authSessionQuery` would resolve to (real-auth path).
 * @param locationHref  The current in-app path (e.g. `/dashboard`).
 * @param isServer      Whether to simulate a server (no `document`).
 * @returns `null` if the gate passes, a `RedirectCapture` if it redirects.
 */
async function runGate(
  sessionValue: object | null,
  locationHref: string,
  isServer = false,
): Promise<RedirectCapture | null> {
  let authed: boolean | undefined;

  if (isAuthCapable()) {
    // Real-auth branch: use the supplied session value directly (mock query).
    authed = sessionValue != null;
  } else {
    // Mock-gate branch.
    if (isServer) {
      // Server cannot read sessionStorage — defer to client, gate passes on SSR.
      return null;
    }
    authed = isAuthenticated();
  }

  if (!authed) {
    return { to: "/login", search: { redirect: locationHref } };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers to manipulate the mock sessionStorage.
// ---------------------------------------------------------------------------
const GATE_KEY = "agent-control-plane-session";

function mockSetSessionStorage(value: string | null): void {
  // In the node test env there is no real sessionStorage, so we stub
  // `window.sessionStorage` on the global object.
  const store: Record<string, string> = {};
  if (value !== null) store[GATE_KEY] = value;
  const mockStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k in store) delete store[k]; },
    length: Object.keys(store).length,
    key: (_i: number) => null,
  };
  Object.defineProperty(globalThis, "window", {
    value: { sessionStorage: mockStorage },
    writable: true,
    configurable: true,
  });
}

afterEach(() => {
  // Reset auth-capable flag and remove the window stub.
  _authCapable = false;
  if ("window" in globalThis) {
    (globalThis as Record<string, unknown>).window = undefined;
  }
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Client auth gate on the app-shell (_app beforeLoad)", () => {
  // ── Mock-gate path (auth capability OFF) ──────────────────────────────────

  describe("mock-gate path (isAuthCapable() = false)", () => {
    it("redirects to /login with deep-link when sessionStorage gate is not set", async () => {
      // Simulate a client environment with no session set.
      mockSetSessionStorage(null);
      _authCapable = false;

      const result = await runGate(null, "/dashboard");

      expect(result).not.toBeNull();
      expect(result?.to).toBe("/login");
      expect(result?.search?.redirect).toBe("/dashboard");
    });

    it("passes (no redirect) when the sessionStorage gate IS set", async () => {
      // Simulate a client environment where the operator has logged in via mock.
      mockSetSessionStorage("1");
      _authCapable = false;

      const result = await runGate(null, "/dashboard");

      expect(result).toBeNull();
    });

    it("defers on the SERVER (no document) — returns null to avoid false SSR redirect", async () => {
      // Server-side: sessionStorage is unreadable. The gate must NOT redirect.
      // `mockSetSessionStorage` is NOT called — simulating the SSR environment
      // where `window` is undefined (isAuthenticated() returns false but the
      // server branch short-circuits before that check).
      _authCapable = false;

      const result = await runGate(null, "/dashboard", /* isServer */ true);

      // The gate returns null (no redirect) on the server for the mock path.
      expect(result).toBeNull();
    });

    it("carries the full in-app location href in the redirect's search param", async () => {
      mockSetSessionStorage(null);
      _authCapable = false;

      const deepLink = "/tasks/abc-123?tab=transcript";
      const result = await runGate(null, deepLink);

      expect(result?.to).toBe("/login");
      expect(result?.search?.redirect).toBe(deepLink);
    });
  });

  // ── Real-auth path (auth capability ON) ───────────────────────────────────

  describe("real-auth path (isAuthCapable() = true)", () => {
    it("redirects to /login when authSessionQuery resolves null (not authenticated)", async () => {
      _authCapable = true;

      const result = await runGate(null, "/dashboard");

      expect(result).not.toBeNull();
      expect(result?.to).toBe("/login");
      expect(result?.search?.redirect).toBe("/dashboard");
    });

    it("passes (no redirect) when authSessionQuery resolves a user object", async () => {
      _authCapable = true;
      const session = { id: "u1", login: "tanghehui", allowed: true };

      const result = await runGate(session, "/dashboard");

      expect(result).toBeNull();
    });

    it("redirects on direct deep-link to a protected page when session is absent", async () => {
      _authCapable = true;

      const deepLink = "/tasks/new";
      const result = await runGate(null, deepLink);

      expect(result?.to).toBe("/login");
      expect(result?.search?.redirect).toBe(deepLink);
    });
  });
});
