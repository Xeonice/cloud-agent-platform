import { describe, expect, it } from "vitest";
import type { SandboxEnvironment } from "@cap/contracts";

import { sandboxEnvironmentDefaultOptions } from "./settings-form";

function environment(overrides: Partial<SandboxEnvironment>): SandboxEnvironment {
  return {
    id: "00000000-0000-4000-a000-000000000501",
    name: "AIO base image",
    status: "ready",
    source: { kind: "aio-docker-image", image: "cap-aio-sandbox:0.1.0" },
    compatibility: { providerFamilies: ["aio"], runtimeIds: ["codex"] },
    isDefault: false,
    lastValidationId: null,
    lastValidatedAt: null,
    contractVersion: "sandbox-environment-v1",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("settings default image options", () => {
  it("uses only selectable image names for the user default dropdown", () => {
    const options = sandboxEnvironmentDefaultOptions([
      environment({ name: "AIO base image" }),
      environment({
        id: "00000000-0000-4000-a000-000000000502",
        name: "BoxLite base image",
        source: { kind: "boxlite-image", image: "cap-boxlite-sandbox:0.1.0" },
        compatibility: { providerFamilies: ["boxlite"] },
      }),
    ]);

    expect(options).toEqual([
      { id: "00000000-0000-4000-a000-000000000501", label: "AIO base image" },
      { id: "00000000-0000-4000-a000-000000000502", label: "BoxLite base image" },
    ]);
  });
});
