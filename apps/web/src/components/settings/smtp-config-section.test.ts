/**
 * Ground-truth test for the SMTP config data seam (add-smtp-config-ui,
 * frontend-console spec "Settings page has an admin-only Resend SMTP section";
 * track frontend, task 5.4).
 *
 * Exercises the seam that backs the Resend SMTP section, WITHOUT a DOM/React
 * render (node env, consistent with the project's vitest.config.ts):
 *   - the `smtpConfigQuery` factory exists with the stable key the settings
 *     loader prefetches;
 *   - the MASKED mock read carries the non-secret fields + a `passLast4` suffix +
 *     a `hasPassword` flag and NEVER the plaintext password;
 *   - the mock save round-trip records only the masked projection (the plaintext
 *     API Key is dropped), and an empty `pass` keeps the stored suffix (留空沿用);
 *   - the mock test-send resolves the `{ ok, message }` outcome without the
 *     password;
 *   - the `settings` capability is `true` (activated), so each `queryFn`/mutation
 *     routes to the REAL api seam — verified against a stubbed `fetch`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mockSmtpConfigRead,
  mockSaveSmtpConfig,
  mockTestSmtpConfig,
  __resetMockSmtpState,
} from "@/lib/api/mock";
import { smtpConfigQuery } from "@/lib/api/queries";
import { getSmtpConfig, saveSmtpConfig, testSmtpConfig } from "@/lib/api/real";

beforeEach(() => {
  __resetMockSmtpState();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Settings SMTP config section — data seam", () => {
  it("smtpConfigQuery factory exists with the correct query key", () => {
    const opts = smtpConfigQuery();
    // The settings loader calls ensureQueryData(smtpConfigQuery()) — the factory
    // must exist and carry the stable key.
    expect(opts.queryKey).toEqual(["settings", "smtp"]);
    expect(typeof opts.queryFn).toBe("function");
  });

  it("masked mock read defaults to unconfigured and never carries the plaintext password", async () => {
    const config = await mockSmtpConfigRead();
    expect(config.hasPassword).toBe(false);
    expect(config.passLast4).toBeNull();
    // The fixed Resend tuple is present; the plaintext key is never on a read.
    expect(config.host).toBe("smtp.resend.com");
    expect(config.port).toBe(465);
    expect(config.user).toBe("resend");
    expect(config).not.toHaveProperty("pass");
    expect(config).not.toHaveProperty("password");
  });

  it("mock save records ONLY the masked projection (the plaintext key is dropped)", async () => {
    const saved = await mockSaveSmtpConfig({
      host: "smtp.resend.com",
      port: 465,
      user: "resend",
      from: "no-reply@auth.example.com",
      pass: "re_test_abcdwZK",
    });
    expect(saved.from).toBe("no-reply@auth.example.com");
    expect(saved.hasPassword).toBe(true);
    expect(saved.passLast4).toBe("dwZK"); // last 4 of the supplied key
    expect(saved).not.toHaveProperty("pass");

    // The subsequent masked read reflects the save (read-state/render loop).
    const reread = await mockSmtpConfigRead();
    expect(reread.hasPassword).toBe(true);
    expect(reread.passLast4).toBe("dwZK");
    expect(reread.from).toBe("no-reply@auth.example.com");
  });

  it("an empty `pass` keeps the stored key suffix (留空沿用现有)", async () => {
    await mockSaveSmtpConfig({
      host: "smtp.resend.com",
      port: 465,
      user: "resend",
      from: "no-reply@auth.example.com",
      pass: "re_first_key1234",
    });
    // Re-save with NO new key, only a changed sender — the suffix must persist.
    const updated = await mockSaveSmtpConfig({
      host: "smtp.resend.com",
      port: 465,
      user: "resend",
      from: "hello@auth.example.com",
    });
    expect(updated.from).toBe("hello@auth.example.com");
    expect(updated.hasPassword).toBe(true);
    expect(updated.passLast4).toBe("1234"); // unchanged — the prior key's suffix
  });

  it("mock test-send resolves the { ok, message } outcome without the password", async () => {
    const result = await mockTestSmtpConfig({
      host: "smtp.resend.com",
      port: 465,
      user: "resend",
      from: "no-reply@auth.example.com",
      pass: "re_probe_key",
    });
    expect(result.ok).toBe(true);
    expect(typeof result.message).toBe("string");
    expect(result).not.toHaveProperty("pass");
    expect(result).not.toHaveProperty("password");
  });

  it("getSmtpConfig routes to the real seam and returns the masked projection (no plaintext)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        host: "smtp.resend.com",
        port: 465,
        user: "resend",
        from: "no-reply@auth.example.com",
        passLast4: "wZK1",
        hasPassword: true,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const config = await getSmtpConfig();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/settings/smtp");
    expect(config.passLast4).toBe("wZK1");
    expect(config.hasPassword).toBe(true);
    // The masked read never carries the plaintext password.
    expect(config).not.toHaveProperty("pass");
  });

  it("saveSmtpConfig sends a PUT to the real seam and parses the masked reply", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        host: "smtp.resend.com",
        port: 465,
        user: "resend",
        from: "no-reply@auth.example.com",
        passLast4: "abcd",
        hasPassword: true,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const saved = await saveSmtpConfig({
      host: "smtp.resend.com",
      port: 465,
      user: "resend",
      from: "no-reply@auth.example.com",
      pass: "re_xxxxabcd",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).method).toBe("PUT");
    // The write carries the plaintext key, but the parsed reply is masked.
    expect(saved.passLast4).toBe("abcd");
    expect(saved).not.toHaveProperty("pass");
  });

  it("testSmtpConfig posts to the real test endpoint and returns { ok, message }", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, message: "已发送" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await testSmtpConfig({
      host: "smtp.resend.com",
      port: 465,
      user: "resend",
      from: "no-reply@auth.example.com",
      pass: "re_probe",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/settings/smtp/test");
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).method).toBe("POST");
    expect(result.ok).toBe(true);
    expect(result.message).toBe("已发送");
  });
});
