import { describe, expect, it } from "vitest";
import type { SandboxEnvironment } from "@cap/contracts";

import {
  IMAGE_PROVIDERS,
  SANDBOX_IMAGE_REGISTRATION_COPY,
  formatValidationError,
  visibleSandboxEnvironments,
} from "./sandbox-environments-card";

function env(overrides: Partial<SandboxEnvironment>): SandboxEnvironment {
  return {
    id: "00000000-0000-4000-a000-000000000001",
    name: "AIO base",
    status: "ready",
    source: { kind: "aio-docker-image", image: "cap-aio:v1" },
    compatibility: { providerFamilies: ["aio"] },
    isDefault: false,
    lastValidationId: null,
    lastValidatedAt: null,
    contractVersion: "sandbox-environment-v1",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("sandbox environments card helpers", () => {
  it("describes registration of existing image references, not upload or build", () => {
    expect(SANDBOX_IMAGE_REGISTRATION_COPY.action).toBe("注册镜像");
    expect(SANDBOX_IMAGE_REGISTRATION_COPY.submit).toBe("保存引用");
    expect(SANDBOX_IMAGE_REGISTRATION_COPY.description).toContain("镜像引用");
    expect(SANDBOX_IMAGE_REGISTRATION_COPY.description).not.toMatch(/上传|构建/);
  });

  it("offers only AIO and BoxLite registry-image provider choices", () => {
    expect(IMAGE_PROVIDERS.map((provider) => provider.value)).toEqual([
      "aio",
      "boxlite",
    ]);
    for (const provider of IMAGE_PROVIDERS) {
      expect(provider.placeholder).toContain("已发布");
      expect(provider.template).toMatch(
        /FROM ghcr\.io\/xeonice\/cap-(aio|boxlite)-sandbox:\$\{CAP_VERSION\}/,
      );
      expect(provider.template).toContain("USER gem");
      expect(provider.template).toContain("WORKDIR /home/gem/workspace");
      expect(`${provider.placeholder}\n${provider.template}`).not.toMatch(
        /rootfs|loaded|upload|上传|构建/,
      );
    }
  });

  it("filters retired environments out of the active image library list", () => {
    const ready = env({ id: "00000000-0000-4000-a000-000000000101" });
    const disabled = env({
      id: "00000000-0000-4000-a000-000000000102",
      status: "disabled",
      name: "Retired image",
    });

    expect(visibleSandboxEnvironments([ready, disabled])).toEqual([ready]);
  });

  it("adds actionable guidance to registry and architecture validation errors", () => {
    expect(
      formatValidationError("BoxLite image registry authorization failed: denied"),
    ).toContain("GHCR token");
    expect(
      formatValidationError("BoxLite image registry transport failed: https"),
    ).toContain("HTTPS registry");
    expect(
      formatValidationError("BoxLite image architecture or runtime mismatch: arm64"),
    ).toContain("linux/arm64");
  });
});
