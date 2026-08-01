import * as fs from "node:fs";
import * as path from "node:path";
import * as React from "react";
import { AGENT_RUNTIME_IDS, RUNTIME_METADATA } from "@cap-console/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * Ground-truth check for unlock-extension-axes / frontend-console requirement:
 * "Runtime display surfaces are driven by contracts metadata with no console
 * branches" — scenario "Credential alert copy comes from the metadata row".
 *
 * Independent of the component's own test suite: this file (a) renders the
 * alert for every contracts-declared runtime and asserts the rendered copy is
 * byte-identical to that runtime's RUNTIME_METADATA row, and (b) statically
 * inspects the component's source text for a runtime-identity branch, which is
 * the exact failure mode the requirement forbids ("no console component SHALL
 * contain a runtime-identity branch ... for display copy").
 */

vi.mock("@tanstack/react-router", async () => {
  const ReactModule = await import("react");
  return {
    Link: ({
      to,
      search,
      hash,
      children,
    }: {
      to: string;
      search?: Record<string, string | undefined>;
      hash?: string;
      children: React.ReactNode;
    }) => {
      const query = new URLSearchParams(
        Object.entries(search ?? {}).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ).toString();
      const href = `${to}${query ? `?${query}` : ""}${hash ? `#${hash}` : ""}`;
      return ReactModule.createElement("a", { href }, children);
    },
  };
});

import {
  RuntimeCredentialAlert,
  type RuntimeAuthFailure,
} from "./runtime-credential-alert";

function failure(runtime: RuntimeAuthFailure["runtime"]): RuntimeAuthFailure {
  return {
    code: "runtime_auth_expired",
    runtime,
    message: "The stored runtime credential can no longer be used.",
    action: "reconnect_runtime",
    occurredAt: new Date("2026-07-31T00:00:00.000Z"),
    exitCode: 1,
  };
}

describe("ground truth: credential alert copy is metadata-driven, not branch-driven", () => {
  it("renders every declared runtime's exact metadata description and action label", () => {
    for (const runtime of AGENT_RUNTIME_IDS) {
      const credential = RUNTIME_METADATA[runtime].credential;
      const html = renderToStaticMarkup(
        <RuntimeCredentialAlert failure={failure(runtime)} />,
      );
      expect(html).toContain(credential.expiredTitle);
      expect(html).toContain(credential.description);
      expect(html).toContain(credential.actionLabel);
    }
  });

  it("contains no runtime-identity branch in the alert component's source", () => {
    const sourcePath = path.resolve(
      __dirname,
      "runtime-credential-alert.tsx",
    );
    const source = fs.readFileSync(sourcePath, "utf8");

    // The exact shape the requirement names as forbidden: a ternary/if/switch
    // keyed on a literal runtime id (e.g. `runtime === 'claude-code'`).
    for (const runtime of AGENT_RUNTIME_IDS) {
      expect(source).not.toContain(`runtime === '${runtime}'`);
      expect(source).not.toContain(`runtime === "${runtime}"`);
      expect(source).not.toMatch(
        new RegExp(`case ['"]${runtime}['"]\\s*:`),
      );
    }
    // No switch statement on `failure.runtime` / `.runtime` at all.
    expect(source).not.toMatch(/switch\s*\(\s*[\w.]*runtime\b/);
  });
});
