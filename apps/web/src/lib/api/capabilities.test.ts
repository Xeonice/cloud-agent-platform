/**
 * Capability flag-map tests (rebuild-console-tanstack-start task 10.8,
 * contract #1, part a).
 *
 * Proves `isCapable()` is a faithful read of the `BACKEND_CAPABILITIES` flag map
 * (not a hardcoded constant): for every domain it must echo exactly the stored
 * flag. The seam DISPATCH (queryFn -> real vs mock) is proven separately in
 * `capability-seam.test.ts`, which has to mock `./capabilities` and so cannot
 * also assert the real flag values from the same module.
 */
import { describe, it, expect } from "vitest";
import { BACKEND_CAPABILITIES, isCapable } from "./capabilities";
import type { BackendCapabilities } from "./capabilities";

describe("isCapable", () => {
  it("returns exactly the flag stored for each domain (no hardcoding)", () => {
    for (const domain of Object.keys(
      BACKEND_CAPABILITIES,
    ) as Array<keyof BackendCapabilities>) {
      expect(isCapable(domain)).toBe(BACKEND_CAPABILITIES[domain]);
    }
  });

  it("reports the verified-real REST domains as capable", () => {
    // These four endpoints ship on the running api today (capabilities.ts).
    expect(isCapable("tasks")).toBe(true);
    expect(isCapable("repos")).toBe(true);
    expect(isCapable("createTask")).toBe(true);
    expect(isCapable("taskProvisioningDiagnostics")).toBe(true);
  });

  it("reports the session-gated domains as capable now their real paths are wired", () => {
    expect(isCapable("auth")).toBe(true);
    expect(isCapable("metrics")).toBe(true);
    expect(isCapable("history")).toBe(true);
    expect(isCapable("settings")).toBe(true);
    expect(isCapable("githubImport")).toBe(true);
    expect(isCapable("branches")).toBe(true);
  });
});
