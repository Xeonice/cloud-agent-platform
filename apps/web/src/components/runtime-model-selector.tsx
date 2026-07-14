import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import {
  type Runtime,
  type RuntimeModelCatalogQuery,
} from "@cap/contracts";
import { runtimeModelsQuery } from "@/lib/api/queries";
import { runtimeModelErrorFromApiError } from "@/lib/api/real";
import {
  ENVIRONMENT_DEFAULT,
  ENVIRONMENT_SERVER_DEFAULT,
} from "@/lib/task-form";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const RUNTIME_DEFAULT_VALUE = "runtime-default";
const MODEL_VALUE_PREFIX = "model:";

export interface RuntimeModelSelectorProps {
  id: string;
  ownerUserId: string | null;
  runtime: Runtime;
  sandboxEnvironmentId: string;
  value: string | null;
  onChange: (model: string | null) => void;
  /** Reports whether an explicit selection is admitted by the current catalog. */
  onValidityChange?: (valid: boolean) => void;
  enabled?: boolean;
  disabledReason?: string;
}

/** Preserve the task API's three environment intents when querying a catalog. */
export function runtimeModelCatalogQueryForEnvironment(
  runtime: Runtime,
  sandboxEnvironmentId: string,
): RuntimeModelCatalogQuery {
  if (sandboxEnvironmentId === ENVIRONMENT_DEFAULT) return { runtime };
  if (sandboxEnvironmentId === ENVIRONMENT_SERVER_DEFAULT) {
    return { runtime, sandboxEnvironmentId: null };
  }
  return { runtime, sandboxEnvironmentId };
}

export type RuntimeModelSelectionCatalogState =
  | { readonly status: "pending" }
  | { readonly status: "error" }
  | { readonly status: "success"; readonly modelIds: readonly string[] };

export interface RuntimeModelSelectionDecision {
  /** Whether the current form value may be submitted. Runtime default is always valid. */
  readonly valid: boolean;
  /** A catalog transition may clear only an explicit selector, never unrelated form state. */
  readonly clearNotice: string | null;
}

/**
 * Pure reconciliation seam shared by the component effects and their tests.
 * A selector is retained only when the newly resolved runtime/environment
 * catalog still contains it; pending/disabled catalogs block submission but do
 * not destructively clear a value, while an authoritative error or success
 * result restores only the model field to runtime-default.
 */
export function runtimeModelSelectionDecision(
  value: string | null,
  catalogEnabled: boolean,
  catalog: RuntimeModelSelectionCatalogState,
): RuntimeModelSelectionDecision {
  if (value === null) return { valid: true, clearNotice: null };
  if (!catalogEnabled || catalog.status === "pending") {
    return { valid: false, clearNotice: null };
  }
  if (catalog.status === "error") {
    return {
      valid: false,
      clearNotice: "模型目录不可用，已恢复为运行时默认；恢复后可重试选择。",
    };
  }
  if (catalog.modelIds.includes(value)) {
    return { valid: true, clearNotice: null };
  }
  return {
    valid: false,
    clearNotice: "原模型不在当前运行时与环境的可用清单中，已恢复为运行时默认。",
  };
}

function selectValue(model: string | null): string {
  return model === null ? RUNTIME_DEFAULT_VALUE : `${MODEL_VALUE_PREFIX}${model}`;
}

function modelFromSelectValue(value: string): string | null {
  return value === RUNTIME_DEFAULT_VALUE
    ? null
    : value.slice(MODEL_VALUE_PREFIX.length);
}

function catalogUnavailableMessage(error: unknown): string {
  const parsed = runtimeModelErrorFromApiError(error);
  if (parsed) {
    return parsed.code === "runtime_model_catalog_unavailable"
      ? "当前模型目录暂不可用，仍可使用运行时默认模型。"
      : parsed.message;
  }
  return "当前模型目录暂不可用，仍可使用运行时默认模型。";
}

/**
 * Shared model picker for immediate and scheduled task creation. The selector
 * never invents model IDs: every explicit option comes from the server's exact
 * runtime/environment catalog, while the default choice is represented by an
 * omitted `model` field.
 */
export function RuntimeModelSelector({
  id,
  ownerUserId,
  runtime,
  sandboxEnvironmentId,
  value,
  onChange,
  onValidityChange,
  enabled = true,
  disabledReason,
}: RuntimeModelSelectorProps): React.ReactElement {
  const catalogEnabled = enabled && ownerUserId !== null;
  const query = React.useMemo(
    () => runtimeModelCatalogQueryForEnvironment(runtime, sandboxEnvironmentId),
    [runtime, sandboxEnvironmentId],
  );
  const catalog = useQuery({
    ...runtimeModelsQuery(ownerUserId ?? "unauthenticated", query),
    enabled: catalogEnabled,
  });
  const [selectionNotice, setSelectionNotice] = React.useState<string | null>(
    null,
  );

  const selectionDecision = runtimeModelSelectionDecision(
    value,
    catalogEnabled,
    catalog.isSuccess
      ? {
          status: "success",
          modelIds: catalog.data.models.map((model) => model.id),
        }
      : catalog.isError
        ? { status: "error" }
        : { status: "pending" },
  );

  React.useEffect(() => {
    onValidityChange?.(selectionDecision.valid);
  }, [onValidityChange, selectionDecision.valid]);

  React.useEffect(() => {
    if (!selectionDecision.clearNotice) return;
    onChange(null);
    setSelectionNotice(selectionDecision.clearNotice);
  }, [
    onChange,
    selectionDecision.clearNotice,
  ]);

  const isInitialLoading = catalogEnabled && catalog.isPending;
  const canChooseExplicit = catalogEnabled && catalog.isSuccess;
  const defaultModel = catalog.data?.defaultModel ?? null;

  return (
    <div className="grid gap-2" data-runtime-model-selector={runtime}>
      <label htmlFor={id} className="text-[13px] font-medium text-foreground">
        模型
      </label>
      <Select
        value={selectValue(value)}
        onValueChange={(next) => {
          setSelectionNotice(null);
          onChange(modelFromSelectValue(next));
        }}
        disabled={!catalogEnabled}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue
            placeholder={isInitialLoading ? "正在读取模型清单…" : "选择模型"}
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={RUNTIME_DEFAULT_VALUE}>
            使用运行时默认
            {defaultModel ? (
              <small className="ml-1.5 text-xs text-muted-foreground">
                当前默认：{defaultModel}
              </small>
            ) : null}
          </SelectItem>
          {canChooseExplicit
            ? catalog.data.models.map((model) => (
                <SelectItem
                  key={model.id}
                  value={`${MODEL_VALUE_PREFIX}${model.id}`}
                >
                  {model.displayName}
                  {model.displayName !== model.id ? (
                    <small className="ml-1.5 font-mono text-xs text-muted-foreground">
                      {model.id}
                    </small>
                  ) : null}
                  {model.isDefault ? (
                    <small className="ml-1.5 text-xs text-muted-foreground">
                      默认
                    </small>
                  ) : null}
                </SelectItem>
              ))
            : null}
        </SelectContent>
      </Select>

      <div aria-live="polite" className="text-xs leading-relaxed text-muted-foreground">
        {!catalogEnabled ? (
          <span>
            {disabledReason ??
              (ownerUserId === null
                ? "正在确认当前账号。"
                : "请先选择可用的运行时与沙箱环境。")}
          </span>
        ) : isInitialLoading ? (
          <span>正在从当前 CLI 与执行环境读取支持的模型清单。</span>
        ) : catalog.isError ? (
          <span className="text-danger">
            {catalogUnavailableMessage(catalog.error)}{" "}
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto px-1 py-0 align-baseline"
              onClick={() => void catalog.refetch()}
              disabled={catalog.isFetching}
            >
              {catalog.isFetching ? "重试中…" : "重试"}
            </Button>
          </span>
        ) : catalog.isSuccess && catalog.data.models.length === 0 ? (
          <span>当前清单没有可显式选择的模型，可继续使用运行时默认。</span>
        ) : catalog.isSuccess ? (
          <span>
            清单来自 {catalog.data.effectiveEnvironment.name}（CLI {catalog.data.cliVersion}）
            {catalog.data.completeness === "supported-subset"
              ? "；当前仅能验证受支持子集。"
              : "；已验证完整清单。"}
          </span>
        ) : null}
        {selectionNotice ? (
          <span className="mt-1 block text-warning">{selectionNotice}</span>
        ) : null}
      </div>
    </div>
  );
}
