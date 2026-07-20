import * as React from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  BookOpen,
  ChevronDown,
  Copy,
  Pencil,
  Play,
  Plus,
  Trash2,
} from "lucide-react";

import type {
  CreateSandboxEnvironmentRequest,
  SandboxEnvironment,
  UpdateSandboxEnvironmentParametersRequest,
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
  queryKeys,
  sandboxEnvironmentValidationsQuery,
  sandboxEnvironmentsQuery,
} from "@/lib/api/queries";
import {
  createSandboxEnvironmentMutation,
  retireSandboxEnvironmentMutation,
  updateSandboxEnvironmentParametersMutation,
  validateSandboxEnvironmentMutation,
} from "@/lib/api/mutations";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

export type SandboxImageProvider = "aio" | "boxlite";

type ImageParameterDraft = {
  readonly name: string;
  readonly value: string;
  readonly secret: boolean;
};

export type EditParameterDraft = {
  readonly name: string;
  readonly value: string;
  readonly secret: boolean;
  /**
   * True while an existing secret's stored value is retained. Secrets are
   * write-only, so a kept row carries no value and submits as `{name, keep}`.
   */
  readonly keepExisting: boolean;
};

/** Prefill edit drafts from the redacted read model: secret rows carry no value. */
export function draftsFromParameters(
  parameters: SandboxEnvironment["parameters"],
): EditParameterDraft[] {
  return (parameters ?? []).map((parameter) =>
    parameter.secret
      ? { name: parameter.name, value: "", secret: true, keepExisting: true }
      : {
          name: parameter.name,
          value: parameter.value ?? "",
          secret: false,
          keepExisting: false,
        },
  );
}

/** Untouched secret rows become keep entries; plaintext never round-trips. */
export function buildUpdateParametersBody(
  drafts: readonly EditParameterDraft[],
): UpdateSandboxEnvironmentParametersRequest {
  return {
    parameters: drafts
      .filter((draft) => draft.name.trim().length > 0)
      .map((draft) =>
        draft.keepExisting
          ? { name: draft.name.trim(), keep: true as const }
          : {
              name: draft.name.trim(),
              value: draft.value,
              secret: draft.secret || undefined,
            },
      ),
  };
}

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
  const updateParams = useMutation(
    updateSandboxEnvironmentParametersMutation(queryClient),
  );
  const [editingEnvironment, setEditingEnvironment] =
    React.useState<SandboxEnvironment | null>(null);
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
              onEditParameters={() => {
                updateParams.reset();
                setEditingEnvironment(environment);
              }}
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
      {editingEnvironment ? (
        <EditParametersDialog
          environment={editingEnvironment}
          saving={updateParams.isPending}
          error={updateParams.error?.message ?? null}
          onClose={() => {
            setEditingEnvironment(null);
            updateParams.reset();
          }}
          onSubmit={(body) => {
            updateParams.mutate(
              { id: editingEnvironment.id, body },
              {
                onSuccess: () => {
                  setEditingEnvironment(null);
                },
                onError: (error) => {
                  // A kept secret can disappear under a concurrent edit; refetch
                  // so the dialog reopens against the current parameter set.
                  if (error.message.includes("unknown_keep_parameter")) {
                    void queryClient.invalidateQueries({
                      queryKey: queryKeys.sandboxEnvironments,
                    });
                  }
                },
              },
            );
          }}
        />
      ) : null}
    </Panel>
  );
}

function EnvironmentRow({
  environment,
  validating,
  retiring,
  onValidate,
  onEditParameters,
  onRetire,
}: {
  environment: SandboxEnvironment;
  validating: boolean;
  retiring: boolean;
  onValidate: () => void;
  onEditParameters: () => void;
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
          variant="outline"
          size="sm"
          onClick={onEditParameters}
          disabled={retiring}
          className="gap-2"
        >
          <Pencil className="size-3.5" />
          参数
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

export function EditParametersFields({
  drafts,
  onReplace,
  onRemove,
  onAdd,
}: {
  drafts: readonly EditParameterDraft[];
  onReplace: (index: number, next: EditParameterDraft) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
}) {
  return (
    <>
      {drafts.length === 0 ? (
        <p className="text-xs text-muted-foreground">暂无参数，点击下方添加。</p>
      ) : null}
      {drafts.map((draft, index) => (
        <div
          key={index}
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto_auto] items-center gap-2"
        >
          <Input
            value={draft.name}
            readOnly={draft.keepExisting}
            aria-label="参数名"
            placeholder="PARAM_NAME"
            onChange={(event) =>
              onReplace(index, { ...draft, name: event.target.value })
            }
            className="font-mono text-xs"
          />
          <Input
            type={draft.secret ? "password" : "text"}
            value={draft.value}
            aria-label="参数值"
            placeholder={draft.keepExisting ? "已保存 · 留空保留现有值" : "参数值"}
            onChange={(event) =>
              onReplace(index, {
                ...draft,
                value: event.target.value,
                keepExisting:
                  draft.keepExisting && event.target.value.length === 0,
              })
            }
            className="font-mono text-xs"
          />
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox
              checked={draft.secret}
              disabled={draft.keepExisting}
              onCheckedChange={(checked) =>
                onReplace(index, { ...draft, secret: checked === true })
              }
            />
            secret
          </label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`移除参数 ${draft.name || index + 1}`}
            onClick={() => onRemove(index)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="justify-self-start gap-2"
        onClick={onAdd}
      >
        <Plus className="size-3.5" />
        添加参数
      </Button>
    </>
  );
}

export function EditParametersDialog({
  environment,
  saving,
  error,
  onClose,
  onSubmit,
}: {
  environment: SandboxEnvironment;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (body: UpdateSandboxEnvironmentParametersRequest) => void;
}) {
  const [drafts, setDrafts] = React.useState<EditParameterDraft[]>(() =>
    draftsFromParameters(environment.parameters),
  );

  function replaceDraft(index: number, next: EditParameterDraft) {
    setDrafts((items) =>
      items.map((item, itemIndex) => (itemIndex === index ? next : item)),
    );
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-w-[min(640px,100vw-32px)]">
        <DialogTitle>编辑运行时参数</DialogTitle>
        <DialogDescription>
          「{environment.name}」的镜像参数。secret 保存后不回显：留空即保留现有值，输入新值即轮换。修改无需重新验证镜像，仅对之后新建的任务生效，运行中的任务不受影响。
        </DialogDescription>
        <DialogBody className="grid gap-2">
          <EditParametersFields
            drafts={drafts}
            onReplace={replaceDraft}
            onRemove={(index) =>
              setDrafts((items) =>
                items.filter((_, itemIndex) => itemIndex !== index),
              )
            }
            onAdd={() =>
              setDrafts((items) => [
                ...items,
                { name: "", value: "", secret: false, keepExisting: false },
              ])
            }
          />
          {error ? (
            <p role="alert" className="text-xs text-danger">
              保存失败：{error}
            </p>
          ) : null}
        </DialogBody>
        <div className="flex items-center justify-end gap-2 border-t border-border px-[22px] py-3.5">
          <DialogClose className="inline-flex min-h-8 items-center rounded-md border border-border bg-card px-3 text-xs font-medium text-foreground transition-colors hover:bg-secondary">
            取消
          </DialogClose>
          <Button
            type="button"
            size="sm"
            disabled={saving}
            onClick={() => onSubmit(buildUpdateParametersBody(drafts))}
          >
            {saving ? "保存中…" : "保存参数"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
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
