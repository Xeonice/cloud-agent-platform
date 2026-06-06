/**
 * SSR Cookie forwarding helper tests (OAuth SSR-first-paint fix).
 *
 * `getIncomingCookieHeader` is a `createIsomorphicFn().client(...).server(...)`.
 * In the BUILD, Start's compiler replaces the whole call with the env-matching
 * branch (client build -> `() => ""`, server build -> the request-reading
 * closure). In THIS suite the compiler does NOT run (vitest.config loads only
 * `tsconfig-paths`), so the untransformed runtime stub is exercised. Per the
 * stub (`@tanstack/start-fn-stubs` createIsomorphicFn), chaining
 * `.client(c).server(s)` resolves the callable to the SERVER impl whenever a
 * server impl is present — so calling `getIncomingCookieHeader()` here drives
 * the SERVER branch. That lets us prove the server behavior directly:
 *   - forwards the incoming request's `Cookie` header via `getRequestHeader`;
 *   - returns "" when no cookie is present;
 *   - degrades to "" (never throws) outside a request scope.
 * The client branch is asserted by calling `.client` in isolation; that it is
 * the ONLY code shipped to the browser (no server entry, no async_hooks) is
 * guaranteed by the production client build, which passes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Control TanStack Start's request accessor. `getRequestHeader` is the exact
// API the helper uses (verified against @tanstack/react-start 1.168.20 ->
// @tanstack/start-server-core request-response).
const getRequestHeader = vi.fn<(name: string) => string | undefined>();
vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeader: (name: string) => getRequestHeader(name),
}));

import { getIncomingCookieHeader } from "./server-cookie";

describe("getIncomingCookieHeader (SSR cookie forwarding)", () => {
  beforeEach(() => {
    getRequestHeader.mockReset();
  });

  it("SSR: forwards the incoming request's Cookie header", async () => {
    getRequestHeader.mockReturnValue("cap_session=abc123; other=1");
    await expect(getIncomingCookieHeader()).resolves.toBe(
      "cap_session=abc123; other=1",
    );
    expect(getRequestHeader).toHaveBeenCalledWith("cookie");
  });

  it("SSR: returns '' when the incoming request has no Cookie header", async () => {
    getRequestHeader.mockReturnValue(undefined);
    await expect(getIncomingCookieHeader()).resolves.toBe("");
  });

  it("SSR: degrades to '' (never throws) when called outside a request scope", async () => {
    getRequestHeader.mockImplementation(() => {
      throw new Error("No StartEvent found in AsyncLocalStorage.");
    });
    await expect(getIncomingCookieHeader()).resolves.toBe("");
  });
});
