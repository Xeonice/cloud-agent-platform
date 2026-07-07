import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, Copy, Play, Plus } from "lucide-react";

import type {
  CreateSandboxEnvironmentRequest,
  SandboxEnvironment,
} from "@cap/contracts";
import { Panel, PanelHead } from "@/components/settings/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  sandboxEnvironmentValidationsQuery,
  sandboxEnvironmentsQuery,
} from "@/lib/api/queries";
import {
  createSandboxEnvironmentMutation,
  validateSandboxEnvironmentMutation,
} from "@/lib/api/mutations";

type SandboxImageProvider = "aio" | "boxlite";

const IMAGE_PROVIDERS: Array<{
  value: SandboxImageProvider;
  label: string;
  placeholder: string;
  templatePath: string;
  template: string;
}> = [
  {
    value: "aio",
    label: "AIO",
    placeholder: "ghcr.io/xeonice/cap-aio-sandbox:0.1.0",
    templatePath: "examples/sandbox-images/aio/Dockerfile",
    template: [
      "ARG CAP_VERSION",
      "FROM ghcr.io/xeonice/cap-aio-sandbox:${CAP_VERSION}",
      "",
      "USER root",
      "RUN apt-get update \\",
      "  && apt-get install -y --no-install-recommends jq ripgrep \\",
      "  && rm -rf /var/lib/apt/lists/*",
      "",
      "USER gem",
      "WORKDIR /home/gem/workspace",
    ].join("\n"),
  },
  {
    value: "boxlite",
    label: "BoxLite",
    placeholder: "ghcr.io/xeonice/cap-boxlite-sandbox:0.1.0",
    templatePath: "examples/sandbox-images/boxlite/Dockerfile",
    template: [
      "ARG CAP_VERSION",
      "FROM ghcr.io/xeonice/cap-boxlite-sandbox:${CAP_VERSION}",
      "",
      "USER root",
      "RUN apt-get update \\",
      "  && apt-get install -y --no-install-recommends jq ripgrep \\",
      "  && rm -rf /var/lib/apt/lists/*",
      "",
      "USER gem",
      "WORKDIR /home/gem/workspace",
    ].join("\n"),
  },
];

export function SandboxEnvironmentsCard() {
  const queryClient = useQueryClient();
  const { data } = useQuery(sandboxEnvironmentsQuery());
  const createEnv = useMutation(createSandboxEnvironmentMutation(queryClient));
  const validateEnv = useMutation(validateSandboxEnvironmentMutation(queryClient));
  const environments = data?.environments ?? [];
  const operationError = createEnv.error?.message ?? validateEnv.error?.message;

  const [name, setName] = React.useState("");
  const [provider, setProvider] = React.useState<SandboxImageProvider>("aio");
  const [reference, setReference] = React.useState("");
  const [runtimeIds, setRuntimeIds] = React.useState("");
  const [showCreate, setShowCreate] = React.useState(false);
  const [copiedProvider, setCopiedProvider] =
    React.useState<SandboxImageProvider | null>(null);
  const selectedProvider = IMAGE_PROVIDERS.find((item) => item.value === provider)!;

  async function copyTemplate() {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(selectedProvider.template);
      setCopiedProvider(provider);
    } catch {
      setCopiedProvider(null);
    }
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const source = buildSource(provider, reference.trim());
    if (!name.trim() || !source) return;
    const body: CreateSandboxEnvironmentRequest = {
      name: name.trim(),
      source,
      runtimeIds: runtimeIds
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    };
    createEnv.mutate(body, {
      onSuccess: () => {
        setName("");
        setReference("");
        setRuntimeIds("");
        setShowCreate(false);
      },
    });
  }

  return (
    <Panel id="sandbox-environments">
      <PanelHead>
        <div className="font-mono text-[11px] uppercase text-muted-foreground">
          Image library
        </div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">镜像库</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              管理可选的 AIO / BoxLite 任务基础镜像。验证通过后会出现在设置页默认镜像下拉里。
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowCreate((value) => !value)}
            className="gap-2"
          >
            <Plus className="size-4" />
            添加镜像
          </Button>
        </div>
      </PanelHead>

      {showCreate ? (
        <form onSubmit={submit} className="mt-4 grid gap-3 rounded-md border border-border bg-muted/20 p-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_180px]">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="镜像名称"
            />
            <Select
              value={provider}
              onValueChange={(value) => setProvider(value as SandboxImageProvider)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {IMAGE_PROVIDERS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2 sm:grid-cols-[1fr_180px]">
            <Input
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder={selectedProvider.placeholder}
            />
            <Input
              value={runtimeIds}
              onChange={(event) => setRuntimeIds(event.target.value)}
              placeholder="runtime: codex"
            />
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={createEnv.isPending} className="gap-2">
              <Plus className="size-4" />
              保存镜像
            </Button>
          </div>
          <div className="rounded-md border border-border bg-background p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="font-mono text-[11px] uppercase text-muted-foreground">
                  Extension template
                </p>
                <p className="mt-1 break-all text-xs text-muted-foreground">
                  {selectedProvider.templatePath}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={copyTemplate}
                className="gap-2"
              >
                <Copy className="size-3.5" />
                {copiedProvider === provider ? "已复制" : "复制模板"}
              </Button>
            </div>
            <pre className="mt-3 max-h-48 overflow-auto rounded-md bg-muted/50 p-3 text-xs leading-5 text-muted-foreground">
              {selectedProvider.template}
            </pre>
          </div>
        </form>
      ) : null}

      {operationError ? (
        <p role="alert" className="mt-3 text-xs text-danger">
          操作失败：{operationError}
        </p>
      ) : null}

      <div className="mt-5 grid gap-2">
        {environments.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
            暂无任务镜像。
          </div>
        ) : (
          environments.map((environment) => (
            <EnvironmentRow
              key={environment.id}
              environment={environment}
              validating={validateEnv.isPending && validateEnv.variables === environment.id}
              onValidate={() => validateEnv.mutate(environment.id)}
            />
          ))
        )}
      </div>
    </Panel>
  );
}

function EnvironmentRow({
  environment,
  validating,
  onValidate,
}: {
  environment: SandboxEnvironment;
  validating: boolean;
  onValidate: () => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const validationQuery = useQuery({
    ...sandboxEnvironmentValidationsQuery(environment.id),
    enabled: expanded,
  });
  const latestValidation = validationQuery.data?.validations[0] ?? null;
  const provider = environment.compatibility.providerFamilies.join(", ");
  const runtimes = environment.compatibility.runtimeIds?.join(", ") || "all";
  return (
    <div className="grid gap-3 rounded-lg border border-border bg-card p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="truncate text-sm text-foreground">{environment.name}</strong>
          <Badge variant={environment.status === "ready" ? "default" : "secondary"}>
            {environment.status}
          </Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {sourceLabel(environment.source.kind)} · {provider} · {runtimes}
        </p>
        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
          {sourceReference(environment)}
        </p>
      </div>
      <div className="flex flex-wrap gap-2 sm:justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onValidate}
          disabled={validating}
          className="gap-2"
        >
          <Play className="size-3.5" />
          验证
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((value) => !value)}
          className="gap-1"
          aria-expanded={expanded}
        >
          详情
          <ChevronDown
            className={`size-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </Button>
      </div>
      {expanded ? (
        <div className="rounded-md border border-border bg-muted/30 p-3 text-xs sm:col-span-2">
          {validationQuery.isLoading ? (
            <p className="text-muted-foreground">正在读取验证记录…</p>
          ) : latestValidation ? (
            <div className="grid gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant={
                    latestValidation.status === "passed" ? "default" : "destructive"
                  }
                >
                  {latestValidation.status}
                </Badge>
                <span className="font-mono text-muted-foreground">
                  {formatDate(latestValidation.checkedAt)}
                </span>
              </div>
              {latestValidation.error ? (
                <p role="alert" className="flex items-start gap-1.5 text-danger">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  {latestValidation.error}
                </p>
              ) : null}
              {latestValidation.probes && latestValidation.probes.length > 0 ? (
                <div className="grid gap-1.5">
                  {latestValidation.probes.map((probe) => (
                    <div
                      key={probe.name}
                      className="grid gap-1 rounded-md bg-background px-2 py-1.5"
                    >
                      <span className="font-medium text-foreground">
                        {probe.name} · {probe.ok ? "ok" : "failed"}
                      </span>
                      {probe.output ? (
                        <span className="break-words font-mono text-muted-foreground">
                          {probe.output}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-muted-foreground">暂无验证记录。</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function buildSource(
  provider: SandboxImageProvider,
  reference: string,
): CreateSandboxEnvironmentRequest["source"] | null {
  if (!reference) return null;
  return provider === "aio"
    ? { kind: "aio-docker-image", image: reference }
    : { kind: "boxlite-image", image: reference };
}

function sourceReference(environment: SandboxEnvironment): string {
  return environment.source.image;
}

function sourceLabel(kind: SandboxEnvironment["source"]["kind"]): string {
  return kind === "aio-docker-image" ? "AIO image" : "BoxLite image";
}

function formatDate(value: Date | string): string {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
