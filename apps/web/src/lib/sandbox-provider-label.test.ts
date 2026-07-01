import { describe, expect, it } from "vitest";

import {
  SANDBOX_PROVIDER_PENDING_LABEL,
  taskSandboxProviderLabel,
} from "./sandbox-provider-label";

describe("taskSandboxProviderLabel", () => {
  it("uses the BoxLite label from TaskResponse", () => {
    expect(
      taskSandboxProviderLabel({
        sandboxProvider: { id: "boxlite", label: "BoxLite Sandbox" },
      }),
    ).toBe("BoxLite Sandbox");
  });

  it("uses the AIO label from TaskResponse", () => {
    expect(
      taskSandboxProviderLabel({
        sandboxProvider: { id: "aio-local", label: "AIO Sandbox" },
      }),
    ).toBe("AIO Sandbox");
  });

  it("does not guess AIO before provider selection", () => {
    expect(taskSandboxProviderLabel({ sandboxProvider: null })).toBe(
      SANDBOX_PROVIDER_PENDING_LABEL,
    );
    expect(taskSandboxProviderLabel({})).toBe(SANDBOX_PROVIDER_PENDING_LABEL);
  });
});
