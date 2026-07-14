import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useQuery } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { RuntimeModelCatalogQuerySchema } from "@cap/contracts";
import {
  ENVIRONMENT_DEFAULT,
  ENVIRONMENT_SERVER_DEFAULT,
} from "@/lib/task-form";
import {
  RuntimeModelSelector,
  runtimeModelCatalogQueryForEnvironment,
  runtimeModelSelectionDecision,
} from "./runtime-model-selector";

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQuery: vi.fn() };
});

const ENVIRONMENT_ID = "00000000-0000-4000-8000-000000000201";
const useQueryMock = useQuery as unknown as Mock;
const CATALOG = {
  runtime: "codex",
  effectiveEnvironment: {
    kind: "deployment-default",
    id: null,
    name: "AIO pinned environment",
    provider: "aio",
    fingerprint: "environment-fingerprint",
  },
  cliVersion: "0.144.1",
  source: "codex-app-server",
  completeness: "supported-subset",
  revision: "catalog-revision-a",
  defaultModel: "provider/default.selector",
  models: [
    {
      id: "provider/default.selector",
      displayName: "Provider default",
      isDefault: true,
      availabilityEvidence: "account-discovered",
    },
    {
      id: "arn:vendor:model/family:v2",
      displayName: "Verified V2",
      isDefault: false,
      availabilityEvidence: "account-discovered",
    },
  ],
} as const;

function renderSelector(
  queryResult: Record<string, unknown>,
  props: Partial<React.ComponentProps<typeof RuntimeModelSelector>> = {},
): string {
  useQueryMock.mockReturnValue({
    data: undefined,
    error: null,
    isPending: false,
    isSuccess: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
    ...queryResult,
  });
  return renderToStaticMarkup(
    React.createElement(RuntimeModelSelector, {
      id: "task-model",
      ownerUserId: "owner-1",
      runtime: "codex",
      sandboxEnvironmentId: ENVIRONMENT_SERVER_DEFAULT,
      value: null,
      onChange: vi.fn(),
      ...props,
    }),
  );
}

beforeEach(() => {
  useQueryMock.mockReset();
});

describe("runtimeModelCatalogQueryForEnvironment", () => {
  it("maps the task form's three environment states without collapsing them", () => {
    const queries = [
      runtimeModelCatalogQueryForEnvironment("codex", ENVIRONMENT_DEFAULT),
      runtimeModelCatalogQueryForEnvironment(
        "codex",
        ENVIRONMENT_SERVER_DEFAULT,
      ),
      runtimeModelCatalogQueryForEnvironment("codex", ENVIRONMENT_ID),
    ];

    expect(queries).toEqual([
      { runtime: "codex" },
      { runtime: "codex", sandboxEnvironmentId: null },
      { runtime: "codex", sandboxEnvironmentId: ENVIRONMENT_ID },
    ]);
    for (const query of queries) {
      expect(RuntimeModelCatalogQuerySchema.safeParse(query).success).toBe(true);
    }
  });

  it("changes query identity with runtime and environment without a static selector list", () => {
    expect(
      runtimeModelCatalogQueryForEnvironment("claude-code", ENVIRONMENT_ID),
    ).toEqual({
      runtime: "claude-code",
      sandboxEnvironmentId: ENVIRONMENT_ID,
    });
    expect(
      runtimeModelSelectionDecision(
        "arn:vendor:model/family:v2",
        true,
        {
          status: "success",
          modelIds: ["arn:vendor:model/family:v2"],
        },
      ),
    ).toEqual({ valid: true, clearNotice: null });
  });
});

describe("runtime model selection reconciliation", () => {
  it("keeps runtime-default valid while pending or disabled", () => {
    expect(
      runtimeModelSelectionDecision(null, false, { status: "pending" }),
    ).toEqual({ valid: true, clearNotice: null });
  });

  it("retains an explicit selector only while the refreshed revision contains it", () => {
    expect(
      runtimeModelSelectionDecision("provider/model:v1", true, {
        status: "success",
        modelIds: ["provider/model:v1"],
      }),
    ).toEqual({ valid: true, clearNotice: null });
    expect(
      runtimeModelSelectionDecision("provider/model:v1", true, {
        status: "success",
        modelIds: ["provider/model:v2"],
      }),
    ).toEqual({
      valid: false,
      clearNotice:
        "原模型不在当前运行时与环境的可用清单中，已恢复为运行时默认。",
    });
  });

  it("clears only explicit selection after a catalog error but not while loading", () => {
    expect(
      runtimeModelSelectionDecision("provider/model:v1", true, {
        status: "pending",
      }),
    ).toEqual({ valid: false, clearNotice: null });
    expect(
      runtimeModelSelectionDecision("provider/model:v1", true, {
        status: "error",
      }),
    ).toEqual({
      valid: false,
      clearNotice: "模型目录不可用，已恢复为运行时默认；恢复后可重试选择。",
    });
  });
});

describe("RuntimeModelSelector accessible states", () => {
  it("renders an associated keyboard-operable combobox and constrained catalog evidence", () => {
    const html = renderSelector({
      data: CATALOG,
      isSuccess: true,
    });

    expect(html).toContain('for="task-model"');
    expect(html).toContain('id="task-model"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("AIO pinned environment");
    expect(html).toContain("CLI 0.144.1");
    expect(html).toContain("当前仅能验证受支持子集");
  });

  it("renders honest loading, empty, error/retry, and disabled states", () => {
    expect(renderSelector({ isPending: true })).toContain(
      "正在从当前 CLI 与执行环境读取支持的模型清单",
    );
    expect(
      renderSelector({
        data: { ...CATALOG, models: [], defaultModel: null },
        isSuccess: true,
      }),
    ).toContain("当前清单没有可显式选择的模型");
    const error = renderSelector({
      error: new Error("transport failed"),
      isError: true,
    });
    expect(error).toContain("当前模型目录暂不可用");
    expect(error).toContain("重试");
    expect(
      renderSelector(
        {},
        {
          enabled: false,
          disabledReason: "请先选择执行环境。",
        },
      ),
    ).toContain("请先选择执行环境");
  });
});
