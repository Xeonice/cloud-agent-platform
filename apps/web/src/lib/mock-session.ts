/**
 * Mock session gate (task 10.6).
 *
 * Reproduces the prototype's client-side token gate so the login flow and the
 * `_app` beforeLoad have an authentication signal before the real backend is
 * available. The single seam is the `auth` capability flag:
 *
 *  - When `BACKEND_CAPABILITIES.auth` is `false` (today), authentication is the
 *    local client gate persisted here; credential methods flip it on,
 *    `logout()` clears it (and resets the local UI store), `isAuthenticated()`
 *    reads it.
 *  - When `auth` flips to `true`, this module defers to the real session:
 *    callers read `authSessionQuery` (which calls `real.getAuthSession()`), and
 *    `logout()` hits `POST /auth/logout`. The local gate is then inert.
 *
 * This keeps the mock/real switch in ONE place and never lets the mock gate
 * masquerade as a real session once the capability is on.
 *
 * The gate fronts two local login methods — email+password and email verification
 * code (OTP) — plus a forced first-login password change. The mock seam covers
 * them without a new persisted-store field: both methods converge on the same
 * `githubConnected` gate (the legacy mock "session established" signal), and
 * `mustChangePassword` is held in module memory so the login route can drive the
 * forced-change dialog under the mock.
 */
import { isCapable } from "./api/capabilities";
import { getAuthCapabilities } from "./api/real";
import { resetState, setState } from "./store";
import { apiBaseUrl } from "./config";

/** The mock account the prototype gate admits (design D1; "tanghehui"). */
export const ALLOWED_ACCOUNT = "tanghehui" as const;

/** `sessionStorage` key for the mock gate (distinct from the persisted store). */
const GATE_KEY = "agent-control-plane-session";

/**
 * The local console login methods. The login modal renders only the
 * methods whose backend capability flag is enabled (`loginCapabilities`).
 */
export type LoginMethod = "password" | "otp";

/**
 * Which login methods the console offers. These mirror the backend capability
 * flags (`passwordAuthEnabled`, `otpAuthEnabled` = SMTP configured). Until the
 * FE reads that live surface, this is the single seam:
 *
 *  - Under the MOCK gate (`auth` off, including the `VITE_FORCE_MOCK` visual
 *    harness) both local methods are reported enabled.
 *  - Under REAL auth password is enabled by default; OTP is disabled until the
 *    live backend capability confirms SMTP is configured.
 *
 * The returned shape is keyed by {@link LoginMethod} so the modal can map over
 * it deterministically and pick the first enabled method as the default tab.
 */
export function loginCapabilities(): Record<LoginMethod, boolean> {
  if (!isAuthCapable()) {
    return { password: true, otp: true };
  }
  // Real posture: safe first paint before the live flags are read. OTP depends
  // on SMTP, which only the backend knows.
  return { password: true, otp: false };
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
    return { password: true, otp: true };
  }
  const caps = await getAuthCapabilities();
  if (!caps) {
    return loginCapabilities();
  }
  return {
    password: caps.passwordAuthEnabled,
    otp: caps.otpAuthEnabled,
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

/** True while real backend auth is wired in; callers should read `authSessionQuery`. */
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
/** The shape every credential login resolves to. */
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
 * the mock session. Used by the password + OTP mock flows.
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
 * store. Under real backend auth, hits `POST /auth/logout` to revoke the server-side
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
