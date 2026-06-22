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
 *
 * add-private-account-identity (track frontend, task 9.3): the gate now fronts
 * THREE login methods — email+password, email verification code (OTP), and
 * GitHub authorization — plus a forced first-login password change. The mock
 * seam grows to cover them WITHOUT a new persisted-store field: the new methods
 * all converge on the same `githubConnected` gate (the single mock "session
 * established" signal), and `mustChangePassword` is held in module memory so the
 * login route can drive the forced-change dialog under the mock. Each function
 * defers to the real backend the moment `auth` is capable, exactly like
 * `login()`/`logout()` already do — the mock is never allowed to shadow a real
 * decision once the capability flips.
 */
import { isCapable } from "./api/capabilities";
import { getAuthCapabilities } from "./api/real";
import { resetState, setState } from "./store";
import { apiBaseUrl } from "./config";
import { safeRelativePath } from "./safe-redirect";

/** The allowlisted account the prototype gate admits (design D1; "tanghehui"). */
export const ALLOWED_ACCOUNT = "tanghehui" as const;

/** `sessionStorage` key for the mock gate (distinct from the persisted store). */
const GATE_KEY = "agent-control-plane-session";

/**
 * The three console login methods (D11). The login modal renders only the
 * methods whose backend capability flag is enabled (`loginCapabilities`).
 */
export type LoginMethod = "password" | "otp" | "github";

/**
 * Which login methods the console offers. These mirror the backend capability
 * flags (`passwordAuthEnabled`, `otpAuthEnabled` = SMTP configured, plus the
 * GitHub-OAuth capability) the api will expose through its capabilities surface
 * (task 2.8). Until the FE reads that live surface, this is the single seam:
 *
 *  - Under the MOCK gate (`auth` off — incl. the `VITE_FORCE_MOCK` visual
 *    harness) ALL three methods are reported enabled so the modal renders its
 *    full 3-method switch on the typed-mock posture (matching the design).
 *  - Under REAL auth the password + GitHub methods are reported enabled; OTP is
 *    reported DISABLED here because its availability depends on SMTP being
 *    configured, which only the backend knows — surfacing it true by default
 *    would offer a method whose prerequisite may be absent (spec: "never present
 *    a method whose backend prerequisite is absent"). When the api exposes the
 *    live `otpAuthEnabled` flag, this reader is the one place that consults it.
 *
 * The returned shape is keyed by {@link LoginMethod} so the modal can map over
 * it deterministically and pick the first enabled method as the default tab.
 */
export function loginCapabilities(): Record<LoginMethod, boolean> {
  if (!isAuthCapable()) {
    // Mock / visual-harness posture: render the full 3-method switch.
    return { password: true, otp: true, github: true };
  }
  // Real posture: a SAFE default for SSR / first paint before the live flags are
  // read — password + GitHub on, OTP off (it depends on SMTP, which only the
  // backend knows). The live values come from {@link fetchLoginCapabilities}.
  return { password: true, otp: false, github: true };
}

/**
 * Reads the LIVE login-method capability flags from the backend (real mode) so
 * the modal renders exactly the enabled methods — in particular OTP only when SMTP
 * is configured. Falls back to the synchronous {@link loginCapabilities} default
 * if the backend flags are unavailable. Under the mock gate it returns the full
 * 3-method set (no backend to consult). Client-only (the login page calls it after
 * mount); never throws.
 */
export async function fetchLoginCapabilities(): Promise<
  Record<LoginMethod, boolean>
> {
  if (!isAuthCapable()) {
    return { password: true, otp: true, github: true };
  }
  const caps = await getAuthCapabilities();
  if (!caps) {
    return loginCapabilities();
  }
  return {
    password: caps.passwordAuthEnabled,
    otp: caps.otpAuthEnabled,
    github: caps.githubAuthEnabled,
  };
}

/**
 * Module-memory flag for the MOCK forced-change flow. The real signal is the
 * backend's `mustChangePassword` on the resolved session (read via
 * `authSessionQuery` once the api carries it); under the mock gate there is no
 * persisted-store field for it, so the login route seeds this when it wants to
 * exercise the forced-change dialog and `changePassword()` clears it.
 */
let mockMustChangePassword = false;

/** True while real OAuth is wired in; callers should read `authSessionQuery`. */
export function isAuthCapable(): boolean {
  // Via `isCapable` (not the raw flag map) so `VITE_FORCE_MOCK=1` — the visual
  // harness's deterministic mock data mode — also returns the AUTH GATE to the
  // sessionStorage mock path, consistent with every data domain.
  return isCapable("auth");
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

/** The shape every credential login resolves to: success + the post-login dest. */
export interface LoginResult {
  /** Whether the credential was accepted (the mock always accepts; real maps the API result). */
  ok: boolean;
  /** A generic, non-disclosing failure message when `ok` is false. */
  error?: string;
  /**
   * Whether the just-authenticated account must change its password before
   * console access (D9). Read from the login response's session user (real mode)
   * or the mock forced-change flag, so the login route can open the forced-change
   * dialog without a second round trip.
   */
  mustChangePassword?: boolean;
}

/**
 * Establish the MOCK session (the shared "logged in" effect for every
 * credential method). Mirrors `login()`'s mock branch: flips the sessionStorage
 * gate AND `store.githubConnected` so `authSessionQuery`/`AccountMenu` resolve
 * the allowlisted session. Used by the password + OTP mock flows.
 */
function establishMockSession(): void {
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(GATE_KEY, "1");
    } catch {
      // Ignore storage failure; the gate simply won't persist across reloads.
    }
  }
  setState({ githubConnected: true });
}

/**
 * Reads `user.mustChangePassword` from a login response body so the login route
 * can open the forced-change dialog right after a credential login. Defensive:
 * returns `false` on any parse failure (the `_app` gate is the backstop on a
 * subsequent navigation).
 */
async function readMustChange(res: Response): Promise<boolean> {
  try {
    const body = (await res.json()) as
      | { user?: { mustChangePassword?: boolean } }
      | null;
    return body?.user?.mustChangePassword === true;
  } catch {
    return false;
  }
}

/**
 * Email + password login (D4/D11). Under the mock gate it accepts any
 * non-empty email/password and establishes the session; under REAL auth it
 * POSTs to the password-login endpoint, which resolves by email → verifies the
 * argon2 hash → requires `allowed` → mints the session cookie. The backend
 * returns a UNIFORM generic failure (no account disclosure) on any rejection.
 */
export async function passwordLogin(
  email: string,
  password: string,
): Promise<LoginResult> {
  if (isAuthCapable()) {
    try {
      const res = await fetch(`${apiBaseUrl()}/auth/password`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) return { ok: false, error: "邮箱或密码不正确。" };
      return { ok: true, mustChangePassword: await readMustChange(res) };
    } catch {
      return { ok: false, error: "登录失败，请稍后重试。" };
    }
  }
  // Mock gate: accept any non-empty credentials and establish the session.
  if (!email.trim() || !password) {
    return { ok: false, error: "请填写邮箱和密码。" };
  }
  establishMockSession();
  return { ok: true, mustChangePassword: mockMustChangePassword };
}

/**
 * Request an email verification code (OTP) for `email` (D4/D11). Under the mock
 * gate this is a no-op success (no code is actually sent). Under REAL auth it
 * POSTs to the OTP-request endpoint, which answers with a UNIFORM non-disclosing
 * response whether or not the email maps to an enabled account.
 */
export async function requestOtp(email: string): Promise<LoginResult> {
  if (isAuthCapable()) {
    try {
      await fetch(`${apiBaseUrl()}/auth/otp/request`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      // Non-disclosing: always report "sent" regardless of the account state.
      return { ok: true };
    } catch {
      return { ok: false, error: "发送失败，请稍后重试。" };
    }
  }
  if (!email.trim()) return { ok: false, error: "请填写邮箱。" };
  return { ok: true };
}

/**
 * Verify an email OTP and, on success, establish the session (D4/D11). Under
 * the mock gate any 6-digit code is accepted; under REAL auth it POSTs to the
 * OTP-verify endpoint, which mints the session for the allowed account.
 */
export async function verifyOtp(
  email: string,
  code: string,
): Promise<LoginResult> {
  if (isAuthCapable()) {
    try {
      const res = await fetch(`${apiBaseUrl()}/auth/otp/verify`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      if (!res.ok) return { ok: false, error: "验证码不正确或已过期。" };
      return { ok: true, mustChangePassword: await readMustChange(res) };
    } catch {
      return { ok: false, error: "登录失败，请稍后重试。" };
    }
  }
  if (!/^\d{6}$/.test(code.trim())) {
    return { ok: false, error: "请输入 6 位数字验证码。" };
  }
  establishMockSession();
  return { ok: true, mustChangePassword: mockMustChangePassword };
}

/**
 * Whether the freshly-authenticated account must change its password before
 * console access (the forced first-login flow, D9). Under REAL auth the
 * load-bearing signal is the backend's `mustChangePassword` on the resolved
 * session; this mock reader covers the local gate so the login route can drive
 * the forced-change dialog without a persisted-store field.
 */
export function mustChangePassword(): boolean {
  if (isAuthCapable()) return false;
  return mockMustChangePassword;
}

/**
 * Seed the MOCK forced-change flag (test/visual-harness hook). No-op under real
 * auth, where the signal comes from the backend session.
 */
export function setMockMustChangePassword(value: boolean): void {
  if (isAuthCapable()) return;
  mockMustChangePassword = value;
}

/**
 * Change the current account's password and clear `mustChangePassword`
 * (D9; the forced first-login flow + the self-service change). Under REAL auth
 * it POSTs the new password to the change-password endpoint (which sets the new
 * argon2 hash, clears the must-change flag, and invalidates the prior temp
 * credential); under the mock gate it just clears the in-memory must-change
 * flag so the console proceeds.
 */
export async function changePassword(newPassword: string): Promise<LoginResult> {
  if (isAuthCapable()) {
    try {
      const res = await fetch(`${apiBaseUrl()}/auth/change-password`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newPassword }),
      });
      if (!res.ok) return { ok: false, error: "密码修改失败，请稍后重试。" };
      return { ok: true };
    } catch {
      return { ok: false, error: "密码修改失败，请稍后重试。" };
    }
  }
  mockMustChangePassword = false;
  return { ok: true };
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
  // Clear the mock forced-change flag so a subsequent mock login starts clean.
  mockMustChangePassword = false;
  resetState();
}
