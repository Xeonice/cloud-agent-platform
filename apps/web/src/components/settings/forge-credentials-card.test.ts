import { describe, expect, it } from "vitest";

import { forgeCredentialStatus } from "./forge-credentials-card";

describe("forgeCredentialStatus", () => {
  it("renders api-unverified credentials as git-saved instead of fully verified", () => {
    expect(forgeCredentialStatus("unverified")).toEqual({
      label: "Git 已保存",
      variant: "warn",
    });
  });

  it("renders absent or verified apiAccess as connected", () => {
    expect(forgeCredentialStatus("verified")).toEqual({
      label: "已连接",
      variant: "green",
    });
    expect(forgeCredentialStatus(undefined)).toEqual({
      label: "已连接",
      variant: "green",
    });
  });
});
