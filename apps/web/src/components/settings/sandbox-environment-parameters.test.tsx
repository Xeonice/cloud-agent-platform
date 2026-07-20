/**
 * Parameter-edit dialog logic (edit-sandbox-environment-parameters). SSR-render
 * assertions keep the suite in the node environment (repo convention): prefill
 * must redact secret values, and untouched secret rows must submit as keep
 * entries so plaintext never round-trips through the client.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SandboxEnvironment } from "@cap/contracts";

import {
  EditParametersFields,
  buildUpdateParametersBody,
  draftsFromParameters,
} from "./sandbox-environments-card";

const REDACTED_PARAMETERS: SandboxEnvironment["parameters"] = [
  { name: "GCODE_API_BASE_URL", value: "https://code.example/api/v5", secret: false },
  { name: "GCODE_TOKEN", secret: true },
];

describe("draftsFromParameters", () => {
  it("prefills plain values and keeps secret rows value-free", () => {
    expect(
      draftsFromParameters([
        { name: "GCODE_API_BASE_URL", value: "https://code.example/api/v5", secret: false },
        { name: "GCODE_TOKEN", secret: true },
      ]),
    ).toEqual([
      {
        name: "GCODE_API_BASE_URL",
        value: "https://code.example/api/v5",
        secret: false,
        keepExisting: false,
      },
      { name: "GCODE_TOKEN", value: "", secret: true, keepExisting: true },
    ]);
    expect(draftsFromParameters(undefined)).toEqual([]);
  });
});

describe("buildUpdateParametersBody", () => {
  it("maps untouched secret rows to keep entries and typed rows to set entries", () => {
    expect(
      buildUpdateParametersBody([
        {
          name: "GCODE_API_BASE_URL",
          value: "https://code.example/api/v6",
          secret: false,
          keepExisting: false,
        },
        { name: "GCODE_TOKEN", value: "", secret: true, keepExisting: true },
        { name: "ROTATED", value: "fresh", secret: true, keepExisting: false },
        { name: "  ", value: "dropped", secret: false, keepExisting: false },
      ]),
    ).toEqual({
      parameters: [
        { name: "GCODE_API_BASE_URL", value: "https://code.example/api/v6", secret: undefined },
        { name: "GCODE_TOKEN", keep: true },
        { name: "ROTATED", value: "fresh", secret: true },
      ],
    });
  });
});

describe("EditParametersFields", () => {
  it("prefills from the redacted read model without rendering secret values", () => {
    const html = renderToStaticMarkup(
      <EditParametersFields
        drafts={draftsFromParameters(REDACTED_PARAMETERS)}
        onReplace={vi.fn()}
        onRemove={vi.fn()}
        onAdd={vi.fn()}
      />,
    );
    expect(html).toContain("GCODE_API_BASE_URL");
    expect(html).toContain("https://code.example/api/v5");
    expect(html).toContain("GCODE_TOKEN");
    expect(html).toContain("留空保留现有值");
    // The secret row renders a password input with an empty value.
    expect(html).toContain('type="password"');
    expect(html).not.toContain("gcode-secret");
  });

  it("submits keep entries for untouched secret rows", () => {
    const onSubmit = vi.fn();
    // The dialog derives its submit body from drafts via the exported pure
    // mapper; assert the same path the button handler uses.
    onSubmit(
      buildUpdateParametersBody(draftsFromParameters(REDACTED_PARAMETERS)),
    );
    expect(onSubmit).toHaveBeenCalledWith({
      parameters: [
        {
          name: "GCODE_API_BASE_URL",
          value: "https://code.example/api/v5",
          secret: undefined,
        },
        { name: "GCODE_TOKEN", keep: true },
      ],
    });
  });
});
