/**
 * Test: Login methods are gated by backend capability flags
 * (add-private-account-identity spec requirement)
 *
 * Scenario 1: OTP method is hidden when SMTP is unconfigured
 *   WHEN the backend reports the OTP capability as false
 *   THEN the login modal does not render the verification-code method
 *        and offers only the remaining enabled methods
 *
 * Scenario 2: Mock mode offers both local methods
 *   WHEN the frontend is in mock posture
 *   THEN the login modal presents password and OTP
 *
 * Strategy: mock `./api/capabilities` so `isCapable("auth")` is controllable,
 * then call `loginCapabilities()` directly and assert the returned flag map
 * that `login.tsx` uses to build `enabledMethods`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Control `isCapable` via a mutable flag.
let _authCapable = false;

vi.mock("./api/capabilities", () => ({
  isCapable: (domain: string) => domain === "auth" && _authCapable,
  forceMock: () => false,
}));

// Stub out store side-effects (imported transitively by mock-session).
vi.mock("./store", () => ({
  resetState: vi.fn(),
  setState: vi.fn(),
}));

// Stub config so apiBaseUrl() does not blow up in node env.
vi.mock("./config", () => ({
  apiBaseUrl: () => "http://localhost:3000",
}));

// Stub safe-redirect (imported by mock-session).
vi.mock("./safe-redirect", () => ({
  safeRelativePath: (p: string | undefined) => p ?? null,
}));

import { loginCapabilities } from "./mock-session";

describe("loginCapabilities() gates login methods by backend capability flags", () => {
  beforeEach(() => {
    _authCapable = false;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("Scenario: OTP method is hidden when SMTP is unconfigured (real-auth posture)", () => {
    // In real-auth mode the backend reports OTP disabled because SMTP may not be configured.
    _authCapable = true;
    const caps = loginCapabilities();

    // password is available in real-auth mode by default
    expect(caps.password).toBe(true);

    // OTP is disabled — the backend prerequisite (SMTP) is absent
    expect(caps.otp).toBe(false);

    // Derive enabled methods exactly as login.tsx does
    const METHOD_ORDER = ["password", "otp"] as const;
    const enabledMethods = METHOD_ORDER.filter((m) => caps[m]);

    // OTP must NOT be in the offered set
    expect(enabledMethods).not.toContain("otp");
    expect(enabledMethods).toEqual(["password"]);
  });

  it("Scenario: Both local methods are offered in mock posture", () => {
    _authCapable = false;
    const caps = loginCapabilities();

    expect(caps.password).toBe(true);
    expect(caps.otp).toBe(true);

    const METHOD_ORDER = ["password", "otp"] as const;
    const enabledMethods = METHOD_ORDER.filter((m) => caps[m]);

    expect(enabledMethods).toEqual(["password", "otp"]);
  });
});
