import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SandboxVersionRegion } from "./$taskId";

describe("SandboxVersionRegion", () => {
  it("renders official and arbitrary declared dependencies from the effective snapshot", () => {
    const html = renderToStaticMarkup(
      <SandboxVersionRegion
        metadata={{
          schemaVersion: 1,
          sandboxVersion: "v1.2.3",
          dependencies: {
            openspec: "1.4.1",
            "custom-cli": "2026.07.10-enterprise-build-with-a-long-version",
            "claude-code": "2.1.181",
            codex: "0.132.0",
          },
        }}
      />,
    );

    expect(html).toContain('aria-label="沙箱版本"');
    expect(html).toContain("Sandbox");
    expect(html).toContain("Codex");
    expect(html).toContain("Claude Code");
    expect(html).toContain("OpenSpec");
    expect(html).toContain("custom-cli");
    expect(html).toContain("break-all");
    expect(html.indexOf("Codex")).toBeLessThan(html.indexOf("Claude Code"));
    expect(html.indexOf("Claude Code")).toBeLessThan(html.indexOf("OpenSpec"));
  });

  it("keeps the startup surface neutral until effective metadata exists", () => {
    expect(renderToStaticMarkup(<SandboxVersionRegion metadata={null} />)).toBe("");
    expect(renderToStaticMarkup(<SandboxVersionRegion />)).toBe("");
  });
});
