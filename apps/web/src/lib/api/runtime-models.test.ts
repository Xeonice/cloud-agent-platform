import { describe, expect, it } from "vitest";

import { queryKeys, runtimeModelsQuery } from "./queries";

const ENVIRONMENT_ID = "00000000-0000-4000-8000-000000000201";

describe("runtime model catalog query identity", () => {
  it("keeps account-default, deployment-default, and managed contexts distinct", () => {
    const accountDefault = queryKeys.runtimeModelCatalog("owner-1", {
      runtime: "codex",
    });
    const deploymentDefault = queryKeys.runtimeModelCatalog("owner-1", {
      runtime: "codex",
      sandboxEnvironmentId: null,
    });
    const managed = queryKeys.runtimeModelCatalog("owner-1", {
      runtime: "codex",
      sandboxEnvironmentId: ENVIRONMENT_ID,
    });

    expect(accountDefault).toEqual([
      "runtime-models",
      "owner-1",
      "codex",
      "account-default",
    ]);
    expect(deploymentDefault).toEqual([
      "runtime-models",
      "owner-1",
      "codex",
      "deployment-default",
    ]);
    expect(managed).toEqual([
      "runtime-models",
      "owner-1",
      "codex",
      "managed",
      ENVIRONMENT_ID,
    ]);
    expect(new Set([JSON.stringify(accountDefault), JSON.stringify(deploymentDefault), JSON.stringify(managed)])).toHaveLength(3);
  });

  it("isolates owner-scoped catalogs and exposes a shared invalidation prefix", () => {
    const ownerOne = queryKeys.runtimeModelCatalog("owner-1", {
      runtime: "claude-code",
    });
    const ownerTwo = queryKeys.runtimeModelCatalog("owner-2", {
      runtime: "claude-code",
    });

    expect(ownerOne).not.toEqual(ownerTwo);
    expect(ownerOne.slice(0, queryKeys.runtimeModels.length)).toEqual(
      queryKeys.runtimeModels,
    );
  });

  it("does not automatically retry an expensive taskless probe", () => {
    const options = runtimeModelsQuery("owner-1", { runtime: "codex" });
    expect(options.retry).toBe(false);
    expect(options.queryKey).toEqual(
      queryKeys.runtimeModelCatalog("owner-1", { runtime: "codex" }),
    );
  });
});
