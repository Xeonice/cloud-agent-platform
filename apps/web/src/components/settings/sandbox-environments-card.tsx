import * as React from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  BookOpen,
  ChevronDown,
  Copy,
  Play,
  Plus,
  Trash2,
} from "lucide-react";

import type {
  CreateSandboxEnvironmentRequest,
  SandboxEnvironment,
} from "@cap/contracts";
import { Panel, PanelHead } from "@/components/settings/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  retireSandboxEnvironmentMutation,
  validateSandboxEnvironmentMutation,
} from "@/lib/api/mutations";

export type SandboxImageProvider = "aio" | "boxlite";

type ImageParameterDraft = {
  readonly name: string;
  readonly value: string;
  readonly secret: boolean;
};

export const SANDBOX_IMAGE_REGISTRATION_COPY = {
  kicker: "Image references",
  title: "镜像库",
  description:
    "注册已发布的 AIO / BoxLite 任务基础镜像引用。验证通过后会出现在设置页默认镜像下拉里。",
  action: "注册镜像",
  submit: "保存引用",
  guide: "扩展指南",
} as const;

export const IMAGE_PROVIDERS: Array<{
  value: SandboxImageProvider;
  label: string;
  placeholder: string;
  templatePath: string;
  template: string;
}> = [
  {
    value: "aio",
    label: "AIO",
    placeholder: "已发布的 AIO 镜像地址，例如 registry.example.com/cap-aio:v1",
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
    placeholder: "已发布的 BoxLite 镜像地址，例如 registry.example.com/cap-boxlite:v1",
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
  const retireEnv = useMutation(retireSandboxEnvironmentMutation(queryClient));
  const environments = visibleSandboxEnvironments(data?.environments ?? []);
  const operationError =
    createEnv.error?.message ?? validateEnv.error?.message ?? retireEnv.error?.message;

  const [name, setName] = React.useState("");
  const [provider, setProvider] = React.useState<SandboxImageProvider>("aio");
  const [reference, setReference] = React.useState("");
  const [runtimeIds, setRuntimeIds] = React.useState("");
  const [parameters, setParameters] = React.useState<ImageParameterDraft[]>([
    { name: "", value: "", secret: false },
  ]);
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
      parameters: parameters
        .map((parameter) => ({
          name: parameter.name.trim(),
          value: parameter.value,
          secret: parameter.secret || undefined,
        }))
        .filter((parameter) => parameter.name.length > 0),
    };
    createEnv.mutate(body, {
      onSuccess: () => {
        setName("");
        setReference("");
        setRuntimeIds("");
        setParameters([{ name: "", value: "", secret: false }]);
        setShowCreate(false);
      },
    });
  }

  return (
    <Panel id="sandbox-environments">
      <PanelHead>
        <div className="font-mono text-[11px] uppercase text-muted-foreground">
          {SANDBOX_IMAGE_REGISTRATION_COPY.kicker}
        </div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              {SANDBOX_IMAGE_REGISTRATION_COPY.title}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {SANDBOX_IMAGE_REGISTRATION_COPY.description}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild type="button" variant="outline" size="sm" className="gap-2">
              <Link to="/help/sandbox-images">
                <BookOpen className="size-4" />
                查看文档
              </Link>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowCreate((value) => !value)}
              className="gap-2"
            >
              <Plus className="size-4" />
              {SANDBOX_IMAGE_REGISTRATION_COPY.action}
            </Button>
          </div>
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
          <div className="rounded-md border border-border bg-background p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-xs font-medium text-foreground">镜像参数</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  写入 /home/gem/.cap/image-env；密钥值保存后不再回显。
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setParameters((items) => [
                    ...items,
                    { name: "", value: "", secret: false },
                  ])
                }
                className="gap-2"
              >
                <Plus className="size-3.5" />
                添加参数
              </Button>
            </div>
            <div className="mt-3 grid gap-2">
              {parameters.map((parameter, index) => (
                <div
                  key={index}
                  className="grid gap-2 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)_auto_auto]"
                >
                  <Input
                    value={parameter.name}
                    onChange={(event) =>
                      setParameters((items) =>
                        replaceParameter(items, index, {
                          ...parameter,
                          name: event.target.value,
                        }),
                      )
                    }
                    placeholder="GCODE_TOKEN"
                  />
                  <Input
                    value={parameter.value}
                    onChange={(event) =>
                      setParameters((items) =>
                        replaceParameter(items, index, {
                          ...parameter,
                          value: event.target.value,
                        }),
                      )
                    }
                    type={parameter.secret ? "password" : "text"}
                    placeholder="参数值"
                  />
                  <label className="flex h-10 items-center gap-2 rounded-md border border-border px-3 text-xs text-muted-foreground">
                    <Checkbox
                      checked={parameter.secret}
                      onCheckedChange={(checked) =>
                        setParameters((items) =>
                          replaceParameter(items, index, {
                            ...parameter,
                            secret: checked === true,
                          }),
                        )
                      }
                    />
                    密钥
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setParameters((items) =>
                        items.length <= 1
                          ? [{ name: "", value: "", secret: false }]
                          : items.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                    className="gap-2 text-muted-foreground"
                  >
                    <Trash2 className="size-3.5" />
                    删除
                  </Button>
                </div>
              ))}
            </div>
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={createEnv.isPending} className="gap-2">
              <Plus className="size-4" />
              {SANDBOX_IMAGE_REGISTRATION_COPY.submit}
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
              <div className="flex flex-wrap gap-2">
                <Button asChild type="button" variant="outline" size="sm" className="gap-2">
                  <Link to="/help/sandbox-images">
                    <BookOpen className="size-3.5" />
                    {SANDBOX_IMAGE_REGISTRATION_COPY.guide}
                  </Link>
                </Button>
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
              retiring={retireEnv.isPending && retireEnv.variables === environment.id}
              onRetire={() => {
                const ok = window.confirm(
                  `停用镜像「${environment.name}」？这只会让 CAP 不再选择该镜像，不会删除 registry 或 BoxLite 上的镜像内容。`,
                );
                if (ok) retireEnv.mutate(environment.id);
              }}
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
  retiring,
  onValidate,
  onRetire,
}: {
  environment: SandboxEnvironment;
  validating: boolean;
  retiring: boolean;
  onValidate: () => void;
  onRetire: () => void;
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
        {environment.parameters && environment.parameters.length > 0 ? (
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
            参数：{formatParameters(environment.parameters)}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2 sm:justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onValidate}
          disabled={validating || retiring}
          className="gap-2"
        >
          <Play className="size-3.5" />
          验证
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRetire}
          disabled={retiring}
          className="gap-2 text-muted-foreground"
        >
          <Archive className="size-3.5" />
          停用
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
                  <span>{formatValidationError(latestValidation.error)}</span>
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
                          {formatValidationError(probe.output)}
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

function replaceParameter(
  items: ImageParameterDraft[],
  index: number,
  next: ImageParameterDraft,
): ImageParameterDraft[] {
  return items.map((item, itemIndex) => (itemIndex === index ? next : item));
}

function formatParameters(
  parameters: NonNullable<SandboxEnvironment["parameters"]>,
): string {
  return parameters
    .map((parameter) =>
      parameter.secret
        ? `${parameter.name}=******`
        : `${parameter.name}=${parameter.value ?? ""}`,
    )
    .join(", ");
}

function formatDate(value: Date | string): string {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function visibleSandboxEnvironments(
  environments: readonly SandboxEnvironment[],
): readonly SandboxEnvironment[] {
  return environments.filter((environment) => environment.status !== "disabled");
}

export function formatValidationError(value: string): string {
  if (/registry authorization/i.test(value)) {
    return `${value}。请确认 provider host 已登录私有 registry，GHCR token 具备 read:packages / package 可见性。`;
  }
  if (/registry transport|registry unreachable|registry pull/i.test(value)) {
    return `${value}。请确认镜像 registry 可由 Docker/BoxLite host 访问；BoxLite registry 引用通常需要可用的 HTTPS registry。`;
  }
  if (/architecture|runtime mismatch/i.test(value)) {
    return `${value}。请确认镜像平台与 sandbox host 匹配，例如 macOS BoxLite 常用 linux/arm64。`;
  }
  if (/command -v|missing|required runtime|tool/i.test(value)) {
    return `${value}。请确认镜像保留官方 entrypoint、gem 用户、/home/gem/workspace，并安装所选 runtime 需要的 CLI。`;
  }
  return value;
}
