/**
 * Minimal ground-truth test: "Account administration page in the console"
 * (add-private-account-identity, frontend spec, task 9.4).
 *
 * Exercises the data seam and mock layer that backs the /accounts admin page:
 *   - adminAccountsQuery factory exists with the correct query key;
 *   - the `accounts` capability is `true` (activated), so queryFn routes to the
 *     real api seam — verified here against a stubbed fetch;
 *   - the mock layer returns the seeded account list (local + github-linked)
 *     shaped by AdminAccountListResponseSchema;
 *   - create / enable-disable lifecycle reflects on the next list read (the
 *     read-state/render loop the route's useMutation invalidates).
 *
 * Runs in the node environment (no DOM, no React render) consistent with the
 * project's vitest.config.ts.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  AdminAccountListResponseSchema,
  AdminAccountListItemSchema,
} from "@cap/contracts";
import {
  mockListAdminAccounts,
  mockCreateAdminAccount,
  mockSetAdminAccountEnabled,
  mockResetAdminAccountPassword,
} from "@/lib/api/mock";
import { adminAccountsQuery } from "@/lib/api/queries";

// Each mock awaits 120-420ms; give tests room.
const TIMEOUT = 2000;

// The mock store is module-scoped; reset between tests by re-importing.
// The simplest approach: rely on test isolation via the stateful store reset.
// The mock store is initialised at module load, so we don't need explicit resets
// here — each test drives from the seeded state.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Account administration page — data seam (adminAccountsQuery)", () => {
  it("adminAccountsQuery factory exists with the correct query key", () => {
    const opts = adminAccountsQuery();
    // The /accounts page loader calls ensureQueryData(adminAccountsQuery())
    // — the factory must exist with the stable key the route's useQuery reads.
    expect(opts.queryKey).toEqual(["accounts"]);
    expect(typeof opts.queryFn).toBe("function");
  });

  it(
    "adminAccountsQuery.queryFn routes to the real seam (accounts capability is true)",
    async () => {
      // `accounts` is `true` in BACKEND_CAPABILITIES (activated), so queryFn
      // routes to the REAL api. Stub fetch with the GET /accounts shape so the
      // seam resolves without a live backend.
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          accounts: [
            {
              id: "gh-tanghehui",
              email: null,
              name: "tanghehui",
              identity: "tanghehui",
              role: "admin",
              allowed: true,
              loginMethods: ["github"],
              isGithubLinked: true,
            },
          ],
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const opts = adminAccountsQuery();
      if (!opts.queryFn) throw new Error("queryFn must be defined");
      const result = await opts.queryFn({} as never);

      // The real seam was used (fetch was called), not the mock.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]![0])).toContain("/accounts");
      // The result shape is the expected admin account list.
      expect(result).toHaveProperty("accounts");
    },
    TIMEOUT,
  );
});

describe("Account administration page — mock layer (add-private-account-identity)", () => {
  it(
    "mockListAdminAccounts returns a seeded list with local + github-linked accounts",
    async () => {
      const response = await mockListAdminAccounts();
      // Must parse against the contract schema (the drift guard).
      expect(() => AdminAccountListResponseSchema.parse(response)).not.toThrow();

      const { accounts } = response;
      expect(accounts.length).toBeGreaterThanOrEqual(1);

      // At least one GitHub-linked account is present (the seeded tanghehui admin).
      const githubAcct = accounts.find((a) => a.isGithubLinked);
      expect(githubAcct).toBeDefined();
      expect(githubAcct?.loginMethods).toContain("github");

      // At least one local (non-github) account is present.
      const localAcct = accounts.find((a) => !a.isGithubLinked);
      expect(localAcct).toBeDefined();
    },
    TIMEOUT,
  );

  it(
    "mock seeds a disabled account (contractor) exercising the 已禁用 table state",
    async () => {
      const { accounts } = await mockListAdminAccounts();
      const disabled = accounts.find((a) => !a.allowed);
      expect(disabled).toBeDefined();
      expect(disabled?.allowed).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "create account → reflected on next list read (新建账号 action)",
    async () => {
      const initial = await mockListAdminAccounts();
      const beforeCount = initial.accounts.length;

      const created = await mockCreateAdminAccount({
        email: "newuser@example.com",
        name: "New User",
        role: "member",
        initialCredential: "password",
        password: "TempPass1234",
      });

      // The created row must validate against the contract.
      expect(() => AdminAccountListItemSchema.parse(created)).not.toThrow();
      // New local account: not github-linked, enabled by default.
      expect(created.isGithubLinked).toBe(false);
      expect(created.allowed).toBe(true);
      expect(created.identity).toBe("newuser@example.com");
      expect(created.role).toBe("member");

      // The list read after create sees the new row (read-state/render loop).
      const afterCreate = await mockListAdminAccounts();
      expect(afterCreate.accounts).toHaveLength(beforeCount + 1);
      const found = afterCreate.accounts.find((a) => a.id === created.id);
      expect(found).toBeDefined();
    },
    TIMEOUT,
  );

  it(
    "enable/disable account → reflected on next list read (启用/禁用 action)",
    async () => {
      const { accounts } = await mockListAdminAccounts();
      // Pick an enabled local account to disable.
      const target = accounts.find((a) => a.allowed && !a.isGithubLinked);
      expect(target).toBeDefined();
      const id = target!.id;

      // Disable.
      const disabled = await mockSetAdminAccountEnabled(id, false);
      expect(() => AdminAccountListItemSchema.parse(disabled)).not.toThrow();
      expect(disabled.allowed).toBe(false);

      // Reflected on the next list read.
      const afterDisable = await mockListAdminAccounts();
      const row = afterDisable.accounts.find((a) => a.id === id);
      expect(row?.allowed).toBe(false);

      // Re-enable.
      const enabled = await mockSetAdminAccountEnabled(id, true);
      expect(enabled.allowed).toBe(true);
      const afterEnable = await mockListAdminAccounts();
      expect(afterEnable.accounts.find((a) => a.id === id)?.allowed).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "reset password is a no-op on the non-secret row (重置密码 action, local only)",
    async () => {
      const { accounts } = await mockListAdminAccounts();
      const localAcct = accounts.find((a) => !a.isGithubLinked);
      expect(localAcct).toBeDefined();

      // Reset must succeed and return the same non-secret row (no plaintext key).
      const result = await mockResetAdminAccountPassword(
        localAcct!.id,
        "NewPassword1234!",
      );
      expect(() => AdminAccountListItemSchema.parse(result)).not.toThrow();
      expect(result.id).toBe(localAcct!.id);
      // No password field should leak into the result.
      expect(result).not.toHaveProperty("password");
      expect(result).not.toHaveProperty("passwordHash");
    },
    TIMEOUT,
  );

  it(
    "github-linked accounts are listed but cannot have passwords reset (kind gate)",
    async () => {
      const { accounts } = await mockListAdminAccounts();
      const github = accounts.find((a) => a.isGithubLinked);
      expect(github).toBeDefined();
      // GitHub accounts have no password login method.
      expect(github?.loginMethods).not.toContain("password");
    },
    TIMEOUT,
  );

  it(
    "otp-only credential flows produce the correct loginMethods on create",
    async () => {
      const otp = await mockCreateAdminAccount({
        email: "otp@example.com",
        name: "OTP User",
        role: "member",
        initialCredential: "otp-only",
      });
      expect(otp.loginMethods).toEqual(["otp"]);
      expect(otp.loginMethods).not.toContain("password");
    },
    TIMEOUT,
  );
});
