/**
 * Mock session gate (task 10.6).
 *
 * Reproduces the prototype's client-side token gate so the login flow and the
 * `_app` allowlist `beforeLoad` have an authentication signal BEFORE the real
 * GitHub-OAuth backend is wired. The single seam is the `auth` capability flag:
 *
 *  - When `BACKEND_CAPABILITIES.auth` is `false` (today), authentication is the
 *    local client gate persisted here — `login()` flips it on, `logout()` clears
 *    it (and resets the local UI store), `isAuthenticated()` reads it.
 *  - When `auth` flips to `true`, this module DEFERS to the real OAuth session:
 *    callers read `authSessionQuery` (which calls `real.getAuthSession()`), and
 *    `login()`/`logout()` initiate the real `GET /auth/github/login` redirect /
 *    `POST /auth/logout`. The local gate is then inert.
 *
 * This keeps the mock/real switch in ONE place and never lets the mock gate
 * masquerade as a real session once the capability is on.
 */
import { BACKEND_CAPABILITIES } from "./api/capabilities";
import { resetState, setState } from "./store";
import { apiBaseUrl } from "./config";
import { safeRelativePath } from "./safe-redirect";

/** The allowlisted account the prototype gate admits (design D1; "tanghehui"). */
export const ALLOWED_ACCOUNT = "tanghehui" as const;

/** `sessionStorage` key for the mock gate (distinct from the persisted store). */
const GATE_KEY = "agent-control-plane-session";

/** True while real OAuth is wired in; callers should read `authSessionQuery`. */
export function isAuthCapable(): boolean {
  return BACKEND_CAPABILITIES.auth;
}

/**
 * Whether the operator is authenticated under the MOCK gate. Meaningful only
 * when `auth` is off; when on, callers must use the real session query instead
 * (this returns `false` so it never shadows a real session decision).
 */
export function isAuthenticated(): boolean {
  if (isAuthCapable()) return false;
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(GATE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Begin a login. Under the mock gate, flips the local flag on (the caller then
 * navigates into the app shell). Under real OAuth, redirects the browser to the
 * backend's GitHub authorization-code start endpoint, forwarding an optional
 * `redirect` deep-link (the app path the auth gate bounced the operator from) as a
 * query param. The backend re-validates it with its open-redirect guard, so a
 * malformed value is harmless; we still only forward a same-origin relative path.
 */
export function login(redirect?: string): void {
  if (isAuthCapable()) {
    if (typeof window !== "undefined") {
      const safe = safeRelativePath(redirect);
      const url = new URL(`${apiBaseUrl()}/auth/github/login`);
      if (safe) url.searchParams.set("redirect", safe);
      window.location.href = url.toString();
    }
    return;
  }
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(GATE_KEY, "1");
  } catch {
    // Ignore storage failure; the gate simply won't persist across reloads.
  }
  // Keep the two mock signals coherent: the `_app` gate reads the sessionStorage
  // flag above, but the mock session SOURCE (`mockAuthSession`) derives identity
  // from `store.githubConnected`. Set both so `AccountMenu`/`authSessionQuery`
  // resolve the allowlisted session instead of falling back to the constant.
  // `logout()`'s `resetState()` clears `githubConnected`, keeping them in sync.
  setState({ githubConnected: true });
}

/**
 * Log out. Under the mock gate, clears the local flag and resets the local UI
 * store. Under real OAuth, hits `POST /auth/logout` to revoke the server-side
 * session (immediate revocation matters because login == host root, D1).
 */
export async function logout(): Promise<void> {
  if (isAuthCapable()) {
    try {
      await fetch(`${apiBaseUrl()}/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
    } catch {
      // Ignore network failure on logout; the client still drops local state.
    }
  }
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.removeItem(GATE_KEY);
    } catch {
      // Ignore.
    }
  }
  resetState();
}
