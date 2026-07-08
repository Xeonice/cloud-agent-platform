import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import type { CreateSandboxEnvironmentRequest } from "@cap/contracts";

const flags: Record<string, boolean> = {};

vi.mock("./capabilities", () => ({
  isCapable: (domain: string) => flags[domain] === true,
}));

vi.mock("./real", () => ({
  listSandboxEnvironments: vi.fn(async () => ({ environments: ["REAL_ENV"] })),
  listSandboxEnvironmentValidations: vi.fn(async (id) => ({
    validations: [`REAL_VALIDATION_${id}`],
  })),
  createSandboxEnvironment: vi.fn(async (body) => ({
    id: "real-env",
    name: body.name,
  })),
  validateSandboxEnvironment: vi.fn(async (id) => ({
    environment: { id },
    validation: { id: "validation-real" },
  })),
  setDefaultSandboxEnvironment: vi.fn(async (id) => ({ id, isDefault: true })),
  retireSandboxEnvironment: vi.fn(async (id) => ({ id, status: "disabled" })),
}));

vi.mock("./mock", () => ({
  mockListSandboxEnvironments: vi.fn(async () => ({ environments: ["MOCK_ENV"] })),
  mockListSandboxEnvironmentValidations: vi.fn(async (id) => ({
    validations: [`MOCK_VALIDATION_${id}`],
  })),
  mockCreateSandboxEnvironment: vi.fn(async (body) => ({
    id: "mock-env",
    name: body.name,
  })),
  mockValidateSandboxEnvironment: vi.fn(async (id) => ({
    environment: { id },
    validation: { id: "validation-mock" },
  })),
  mockSetDefaultSandboxEnvironment: vi.fn(async (id) => ({
    id,
    isDefault: true,
  })),
  mockRetireSandboxEnvironment: vi.fn(async (id) => ({
    id,
    status: "disabled",
  })),
}));

import {
  sandboxEnvironmentValidationsQuery,
  sandboxEnvironmentsQuery,
  queryKeys,
} from "./queries";
import {
  createSandboxEnvironmentMutation,
  retireSandboxEnvironmentMutation,
  setDefaultSandboxEnvironmentMutation,
  validateSandboxEnvironmentMutation,
} from "./mutations";
import * as real from "./real";
import * as mock from "./mock";

type Spy = ReturnType<typeof vi.fn>;

function queryClientStub() {
  return {
    invalidateQueries: vi.fn(),
  } as unknown as QueryClient & { invalidateQueries: Spy };
}

async function runQueryFn(factory: () => { queryFn?: unknown }): Promise<unknown> {
  const opts = factory();
  const queryFn = opts.queryFn as (ctx: unknown) => unknown;
  expect(typeof queryFn).toBe("function");
  return queryFn({} as unknown);
}

describe("sandbox environment api seam", () => {
  beforeEach(() => {
    for (const key of Object.keys(flags)) delete flags[key];
    vi.clearAllMocks();
  });

  it("list query routes through the settings capability and uses the stable key", async () => {
    expect(sandboxEnvironmentsQuery().queryKey).toEqual(queryKeys.sandboxEnvironments);

    flags.settings = true;
    await expect(runQueryFn(sandboxEnvironmentsQuery)).resolves.toEqual({
      environments: ["REAL_ENV"],
    });
    expect(real.listSandboxEnvironments).toHaveBeenCalledTimes(1);
    expect(mock.mockListSandboxEnvironments).not.toHaveBeenCalled();

    vi.clearAllMocks();

    flags.settings = false;
    await expect(runQueryFn(sandboxEnvironmentsQuery)).resolves.toEqual({
      environments: ["MOCK_ENV"],
    });
    expect(mock.mockListSandboxEnvironments).toHaveBeenCalledTimes(1);
    expect(real.listSandboxEnvironments).not.toHaveBeenCalled();
  });

  it("validation history query uses a per-environment key and seam", async () => {
    expect(sandboxEnvironmentValidationsQuery("env-1").queryKey).toEqual(
      queryKeys.sandboxEnvironmentValidations("env-1"),
    );

    flags.settings = true;
    await expect(
      runQueryFn(() => sandboxEnvironmentValidationsQuery("env-1")),
    ).resolves.toEqual({ validations: ["REAL_VALIDATION_env-1"] });
    expect(real.listSandboxEnvironmentValidations).toHaveBeenCalledWith("env-1");

    vi.clearAllMocks();

    flags.settings = false;
    await expect(
      runQueryFn(() => sandboxEnvironmentValidationsQuery("env-1")),
    ).resolves.toEqual({ validations: ["MOCK_VALIDATION_env-1"] });
    expect(mock.mockListSandboxEnvironmentValidations).toHaveBeenCalledWith("env-1");
  });

  it("create mutation sends the environment payload and invalidates the list", async () => {
    flags.settings = true;
    const client = queryClientStub();
    const body: CreateSandboxEnvironmentRequest = {
      name: "Internal AIO",
      source: { kind: "aio-docker-image", image: "registry.local/cap/aio:v1" },
      runtimeIds: ["codex"],
      isDefault: true,
    };
    const options = createSandboxEnvironmentMutation(client);

    await options.mutationFn!(body, {} as never);
    options.onSuccess?.(
      { id: "real-env", name: body.name } as never,
      body,
      undefined,
      {} as never,
    );

    expect(real.createSandboxEnvironment).toHaveBeenCalledWith(body);
    expect(client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.sandboxEnvironments,
    });
  });

  it("validate and default mutations refresh the same environment list key", async () => {
    flags.settings = true;
    const client = queryClientStub();
    const validateOptions = validateSandboxEnvironmentMutation(client);
    const defaultOptions = setDefaultSandboxEnvironmentMutation(client);

    await validateOptions.mutationFn!("env-1", {} as never);
    validateOptions.onSuccess?.({} as never, "env-1", undefined, {} as never);
    await defaultOptions.mutationFn!("env-1", {} as never);
    defaultOptions.onSuccess?.({} as never, "env-1", undefined, {} as never);

    expect(real.validateSandboxEnvironment).toHaveBeenCalledWith("env-1");
    expect(real.setDefaultSandboxEnvironment).toHaveBeenCalledWith("env-1");
    expect(client.invalidateQueries).toHaveBeenCalledTimes(3);
    expect(client.invalidateQueries).toHaveBeenNthCalledWith(1, {
      queryKey: queryKeys.sandboxEnvironments,
    });
    expect(client.invalidateQueries).toHaveBeenNthCalledWith(2, {
      queryKey: queryKeys.sandboxEnvironmentValidations("env-1"),
    });
    expect(client.invalidateQueries).toHaveBeenNthCalledWith(3, {
      queryKey: queryKeys.sandboxEnvironments,
    });
  });

  it("retire mutation refreshes environment list and validation history", async () => {
    flags.settings = true;
    const client = queryClientStub();
    const options = retireSandboxEnvironmentMutation(client);

    await options.mutationFn!("env-1", {} as never);
    options.onSuccess?.({} as never, "env-1", undefined, {} as never);

    expect(real.retireSandboxEnvironment).toHaveBeenCalledWith("env-1");
    expect(client.invalidateQueries).toHaveBeenCalledTimes(2);
    expect(client.invalidateQueries).toHaveBeenNthCalledWith(1, {
      queryKey: queryKeys.sandboxEnvironments,
    });
    expect(client.invalidateQueries).toHaveBeenNthCalledWith(2, {
      queryKey: queryKeys.sandboxEnvironmentValidations("env-1"),
    });
  });
});
