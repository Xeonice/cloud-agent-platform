/**
 * `getAuthSession` 401-handling test (auth-redirects-and-landing, gate fix).
 *
 * The `_app` auth gate is now load-bearing on SERVER-side resolution (a direct
 * load / refresh / deep-link does not re-run `beforeLoad` on the client during
 * hydration). Per `multi-user-oauth`, an unauthenticated `/auth/session` is
 * answered with HTTP 401 (no `200 { user: null }` body). For the gate to
 * cleanly REDIRECT a logged-out visitor — rather than reject into the route
 * error boundary — `getAuthSession` MUST map that 401 to `null` while still
 * propagating genuine failures (5xx/network). This pins exactly that contract.
 *
 * Pure node-env: `fetch`, `../config`, and `../server-cookie` are stubbed so the
 * real `request()` path runs against synthetic responses (not a tautology — a
 * regression that swallowed all errors, or that re-threw the 401, would fail).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config", () => ({
  apiBaseUrl: () => "http://api.test",
  operatorToken: () => undefined,
}));
vi.mock("../server-cookie", () => ({
  getIncomingCookieHeader: async () => "",
}));

import { getAuthSession, ApiError } from "./real";

const VALID_USER = {
  id: "u_12345",
  githubId: 12345,
  login: "tanghehui",
  name: "Tang Hehui",
  avatarUrl: "https://avatars.example/u/12345",
  allowed: true,
  role: "admin",
  mustChangePassword: false,
};

function stubFetch(response: Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getAuthSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps a 401 (logged out) to null rather than throwing", async () => {
    stubFetch(
      new Response(JSON.stringify({ error: "Not authenticated." }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(getAuthSession()).resolves.toBeNull();
  });

  it("returns the session user on a 200", async () => {
    stubFetch(
      new Response(JSON.stringify({ user: VALID_USER }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(getAuthSession()).resolves.toEqual(VALID_USER);
  });

  it("propagates a genuine failure (5xx) instead of masking it as logged out", async () => {
    stubFetch(new Response("upstream exploded", { status: 500 }));
    await expect(getAuthSession()).rejects.toBeInstanceOf(ApiError);
    // And it is NOT silently coerced to null (the 401-only mapping is precise).
    stubFetch(new Response("upstream exploded", { status: 500 }));
    await expect(getAuthSession()).rejects.toMatchObject({ status: 500 });
  });
});
