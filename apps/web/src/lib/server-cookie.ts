/**
 * SSR Cookie forwarding helper.
 *
 * THE PROBLEM: app-shell route loaders call `ensureQueryData(...)`, whose
 * queryFns run ON THE SERVER during SSR and hit the cross-origin api via
 * `lib/api/real.ts`. The browser's httpOnly session cookie lives
 * in the user's browser, NOT in the Nitro/node server process — so an SSR
 * backend `fetch` carries no session and the api answers 401, the loader
 * throws, and the SSR first paint becomes a 500. (Client-side navigation works
 * because the browser attaches the cookie itself.) Under the legacy
 * single-token api this was latent: `VITE_AUTH_TOKEN` is an env var the server
 * also reads, so SSR fetches were bearer-authenticated. It only surfaced in
 * cookie-only mode.
 *
 * THE FIX: during SSR, read the INCOMING browser request's `Cookie` header and
 * forward it onto the outgoing backend `fetch`, so the server-side fetch
 * carries the same session cookie the browser would have sent.
 *
 * THE API: TanStack Start exposes the current request during SSR through an
 * `AsyncLocalStorage`-backed accessor. In the installed version
 * (`@tanstack/react-start` 1.168.20, whose `./server` subpath re-exports
 * `@tanstack/react-start-server` -> `@tanstack/start-server-core`
 * `request-response`), the accessor is `getRequestHeader(name)`, which returns
 * `string | undefined`.
 *
 * THE SEAM: `getRequestHeader` lives behind `@tanstack/react-start/server`,
 * which pulls in `node:async_hooks` and is therefore server-only — importing it
 * into the client graph is rejected by Start's import-protection. So we wrap it
 * in `createIsomorphicFn().server(...).client(...)`: Start's compiler REPLACES
 * the whole call with just the matching env branch (client build keeps the
 * `.client()` body; server build keeps the `.server()` body). The server-only
 * `import()` lives INSIDE the `.server()` closure, so it is dropped wholesale
 * from the client bundle and never reaches import-protection. Result:
 *   - client: returns "" immediately (the browser attaches the cookie to fetch
 *     itself via `credentials: "include"`); the server entry is never bundled;
 *   - server with no incoming cookie: returns "" (no crash);
 *   - server outside a request scope: `getRequestHeader` THROWS
 *     ("No StartEvent found in AsyncLocalStorage"); we catch and degrade to "".
 */
import { createIsomorphicFn } from "@tanstack/react-start";

/**
 * Returns the incoming browser request's `Cookie` header during SSR, or `""`
 * on the client / when no request scope or cookie is available. Never throws.
 * Async because the SSR branch dynamically imports the server-only Start entry.
 */
export const getIncomingCookieHeader = createIsomorphicFn()
  // Client: the browser attaches the session cookie to fetch automatically.
  .client(async () => "")
  .server(async () => {
    try {
      // Server-only entry; the dynamic import lives inside this branch so the
      // compiler drops it (and its `node:async_hooks` dependency) from the
      // client bundle along with this whole closure.
      const { getRequestHeader } = await import("@tanstack/react-start/server");
      return getRequestHeader("cookie") ?? "";
    } catch {
      // Called outside a request scope (no StartEvent in AsyncLocalStorage), or
      // the server entry is unavailable — degrade to no forwarded cookie.
      return "";
    }
  });
