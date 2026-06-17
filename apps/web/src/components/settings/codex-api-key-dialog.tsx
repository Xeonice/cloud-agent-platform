/**
 * `CodexApiKeyDialog` — the 兼容模型提供方 configuration dialog (Track 14, 14.5;
 * wired live by wire-compatible-provider-execution tasks 4.2 + 3.7).
 *
 * A shadcn `Dialog` form. Header ("配置模型 API Key"), then:
 *   - Base URL (`type="url"`) + API Key (`type="password"`) inputs. The key
 *     field is ALWAYS empty on open — it is NEVER pre-filled from a saved
 *     credential (the read contract exposes only `hasApiKey` + a masked suffix,
 *     so there is no plaintext to restore). A small note states the key is not
 *     re-shown after saving, plus a Responses-API requirement note (task 3.7).
 *   - 获取可用模型 → REAL model discovery (`discoverCodexModelsMutation` →
 *     `POST /settings/codex/models`, task 4.2). The api probes the candidate
 *     `{baseUrl, apiKey}` (SSRF-guarded, time-bounded, body-capped) WITHOUT
 *     persisting and returns the distinguishable outcome; the discovered list
 *     populates the model picker. A failure surfaces its REAL outcome class
 *     (blocked / auth-failed / unreachable / malformed) and does NOT flip to a
 *     usable/connected state.
 *   - 选择模型 `Select` (the picker) + a model-count line; a selection is
 *     REQUIRED before save.
 *   - `.codex-login-state` dot/text mirroring whether a credential is saved.
 *   - Footer: 保存提供方 (submit → `onSave` `mode:'compatible'`, the key dropped to
 *     `hasApiKey` + masked suffix by the mutation; GATED on a successful probe +
 *     a selected model), 测试凭据 (re-runs the same real probe and reports its
 *     actual outcome class WITHOUT exposing the key and WITHOUT connecting on
 *     failure), 取消.
 *
 * SECURITY: the plaintext key lives only in transient form state, is sent on the
 * probe (Authorization bearer, never logged/returned by the api) and on save
 * (where the mutation projects it to a non-secret presence flag + suffix), and
 * is wiped from the field whenever the dialog closes/reopens. It is never read
 * back or displayed.
 *
 * SSR-safe: Radix portals on the client; the form state is plain `useState`; the
 * probe runs only on an explicit click (an effect/event, never during render).
 *
 * Fidelity: dialog `min(720px,100vw-32px)`; `.model-fetch-row` = soft `#fafafa`
 * tile, radius 8, ring, wrap flex; `.codex-model-picker` = accent-tinted tile,
 * radius 8, accent ring; `.codex-login-state` = soft pill, radius full, ring,
 * dot + 12px text; actions = top hairline, 14/22/18 pad.
 */
import * as React from "react";
import { useMutation } from "@tanstack/react-query";

import type {
  DiscoverModelsResponse,
  ModelDiscoveryErrorCode,
  SaveCodexCredentialRequest,
} from "@cap/contracts";
import { cn } from "@/utils";
import { discoverCodexModelsMutation } from "@/lib/api/mutations";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Human-readable, secret-free copy for each distinguishable discovery outcome
 * class (task 4.2): the probe reports WHICH failure occurred — an unsafe/blocked
 * Base URL, a rejected credential, an unreachable provider, or a malformed model
 * list — so the dialog reflects the REAL outcome instead of a client-side
 * non-empty-field guess. Falls back to the api-supplied message for any code.
 */
const DISCOVERY_ERROR_COPY: Record<ModelDiscoveryErrorCode, string> = {
  provider_url_blocked:
    "Base URL 被安全策略拒绝（协议或主机不被允许，未发起请求）。",
  provider_auth_failed: "测试失败：提供方拒绝了该 API Key（鉴权未通过）。",
  provider_unreachable: "测试失败：无法连接到该提供方（网络/超时/非 2xx）。",
  provider_bad_response: "测试失败：提供方返回的模型列表无法解析。",
};

export interface CodexApiKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whether a compatible credential is already saved (drives the login-state). */
  hasSavedKey: boolean;
  /** Masked suffix of the saved key, for the login-state copy (never the key). */
  savedKeySuffix?: string | null;
  /** The previously saved (non-secret) base URL, pre-filled for convenience. */
  savedBaseUrl?: string | null;
  /** Whether a save is in flight. */
  saving?: boolean;
  /** Persist the compatible credential (`saveCodexCredentialMutation`). */
  onSave: (body: SaveCodexCredentialRequest) => void;
}

/** The compatible-provider configuration dialog. */
export function CodexApiKeyDialog({
  open,
  onOpenChange,
  hasSavedKey,
  savedKeySuffix,
  savedBaseUrl,
  saving = false,
  onSave,
}: CodexApiKeyDialogProps) {
  // Base URL pre-fills from the saved (non-secret) value; the KEY never does.
  const [baseUrl, setBaseUrl] = React.useState<string>(savedBaseUrl ?? "");
  const [apiKey, setApiKey] = React.useState<string>("");
  const [models, setModels] = React.useState<string[]>([]);
  const [model, setModel] = React.useState<string>("");
  const [fetchStatus, setFetchStatus] = React.useState<string>(
    "等待填写连接信息",
  );
  const [testResult, setTestResult] = React.useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  // A save is permitted ONLY after a successful probe of the CURRENT
  // {baseUrl, apiKey} (task 4.2): the operator cannot persist a provider the api
  // never validated. Reset on any input edit so a stale probe can't gate a save.
  const [probePassed, setProbePassed] = React.useState<boolean>(false);

  const discover = useMutation(discoverCodexModelsMutation());

  // Reset transient state whenever the dialog opens; the KEY is always cleared
  // (never restored from a saved credential), and the probe gate is re-armed.
  React.useEffect(() => {
    if (open) {
      setBaseUrl(savedBaseUrl ?? "");
      setApiKey("");
      setModels([]);
      setModel("");
      setFetchStatus("等待填写连接信息");
      setTestResult(null);
      setProbePassed(false);
      discover.reset();
    }
    // Intentionally keyed only on [open, savedBaseUrl]: this is the open/reset
    // effect. The `useMutation` handle changes identity each render, so adding it
    // would re-run on every render and wipe in-flight probe state; `discover` is
    // referenced only to clear it when the dialog (re)opens.
  }, [open, savedBaseUrl]);

  /**
   * Applies a real discovery outcome to the dialog (shared by 获取可用模型 and
   * 测试凭据): success populates the picker + arms the save gate; any failure
   * surfaces its REAL outcome class and DISARMS the gate (no connect on failure).
   */
  function applyDiscovery(result: DiscoverModelsResponse) {
    if (result.ok) {
      setModels(result.models);
      // Preserve the current selection if the provider still offers it, else
      // default to the first reported model (empty when the list is empty).
      setModel((prev) =>
        prev && result.models.includes(prev) ? prev : (result.models[0] ?? ""),
      );
      setProbePassed(true);
      setFetchStatus(`已获取 ${result.models.length} 个可用模型`);
      setTestResult({ ok: true, text: "测试通过：连接信息与凭据可用。" });
    } else {
      setModels([]);
      setModel("");
      setProbePassed(false);
      const copy = DISCOVERY_ERROR_COPY[result.error] ?? result.message;
      setFetchStatus(copy);
      setTestResult({ ok: false, text: copy });
    }
  }

  /**
   * Runs the real probe (`POST /settings/codex/models`). A `{ ok:false }` body is
   * the provider-level outcome and resolves normally; only a transport/HTTP error
   * rejects (rendered as an unreachable-class failure). The probe needs both a
   * Base URL and an API key — neither is preserved by omission on discovery.
   */
  function runProbe() {
    if (!baseUrl.trim() || !apiKey.trim()) {
      setProbePassed(false);
      setModels([]);
      setModel("");
      const copy = "请先填写 Base URL 与 API Key，再测试 / 获取模型。";
      setFetchStatus(copy);
      setTestResult({ ok: false, text: copy });
      return;
    }
    setFetchStatus("正在测试连接并获取可用模型…");
    discover.mutate(
      { baseUrl: baseUrl.trim(), apiKey: apiKey.trim() },
      {
        onSuccess: (result) => applyDiscovery(result),
        onError: () => {
          setModels([]);
          setModel("");
          setProbePassed(false);
          const copy = "测试失败：请求未能送达提供方（网络错误）。";
          setFetchStatus(copy);
          setTestResult({ ok: false, text: copy });
        },
      },
    );
  }

  // Editing any connection input invalidates the previous probe: a save must be
  // gated on a probe of the CURRENT values, never a stale one.
  function onBaseUrlChange(next: string) {
    setBaseUrl(next);
    setProbePassed(false);
  }
  function onApiKeyChange(next: string) {
    setApiKey(next);
    setProbePassed(false);
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Gate: only a provider validated by a real successful probe, with a model
    // selected from the reported list, may be saved (task 4.2).
    if (!probePassed || !model.trim()) return;
    const body: SaveCodexCredentialRequest = { mode: "compatible" };
    if (baseUrl.trim()) body.baseUrl = baseUrl.trim();
    // Send the key only if the operator typed one; omitting it preserves the
    // previously stored key (per the contract). The mutation drops the plaintext.
    if (apiKey.trim()) body.apiKey = apiKey.trim();
    if (model.trim()) body.defaultModel = model.trim();
    onSave(body);
  }

  const probing = discover.isPending;
  // Save is enabled only behind a fresh successful probe + a selected model.
  const canSave = probePassed && model.trim().length > 0 && !saving && !probing;

  // The login-state line reflects whether a credential is currently saved.
  const ready = hasSavedKey;
  const loginStateText = ready
    ? `已保存模型调用凭据${savedKeySuffix ? ` ····${savedKeySuffix}` : ""}`
    : "未保存模型调用凭据";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-labelledby="codexApiTitle"
        className="flex max-h-[85vh] flex-col gap-0 overflow-hidden rounded-xl p-0 shadow-modal sm:max-w-[720px]"
      >
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <header className="flex shrink-0 items-start justify-between gap-4 p-[22px_22px_14px]">
            <div className="min-w-0">
              <span className="font-mono text-[11px] font-medium text-muted-foreground">
                兼容提供方
              </span>
              <DialogTitle
                id="codexApiTitle"
                className="mt-1 mb-1.5 text-[22px] font-semibold tracking-[-0.8px] text-ink"
              >
                配置模型 API Key
              </DialogTitle>
              <DialogDescription className="text-[13px] leading-[1.55] text-muted-foreground">
                把模型运行凭据和控制台登录身份分开管理。API Key 只作为远端 Agent 的模型调用凭据。
                <br />
                提供方必须兼容 OpenAI Responses API（不能仅支持 chat-completions），codex 才能正常调用。
              </DialogDescription>
            </div>
            <DialogClose
              aria-label="关闭"
              className="grid size-8 flex-none place-items-center rounded-md bg-transparent text-2xl leading-none text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              ×
            </DialogClose>
          </header>

          <DialogBody>
          <div className="grid gap-3.5 p-[0_22px_18px]">
            <div className="grid gap-3">
              <div className="grid gap-2">
                <label
                  htmlFor="codexBaseUrl"
                  className="text-[13px] font-semibold text-foreground"
                >
                  Base URL
                </label>
                <input
                  id="codexBaseUrl"
                  name="codexBaseUrl"
                  type="url"
                  value={baseUrl}
                  onChange={(e) => onBaseUrlChange(e.target.value)}
                  placeholder="https://api.example.com/v1"
                  autoComplete="off"
                  className="min-h-10 w-full min-w-0 rounded-md bg-card px-3 text-[13px] text-foreground shadow-[0_0_0_1px_var(--border)] focus:shadow-[0_0_0_1px_var(--ring),0_0_0_3px_rgba(10,114,239,0.16)] focus:outline-none"
                />
              </div>
              <div className="grid gap-2">
                <label
                  htmlFor="codexApiKey"
                  className="text-[13px] font-semibold text-foreground"
                >
                  API Key
                </label>
                <input
                  id="codexApiKey"
                  name="codexApiKey"
                  type="password"
                  value={apiKey}
                  onChange={(e) => onApiKeyChange(e.target.value)}
                  placeholder={hasSavedKey ? "已保存（重新输入以更新）" : "sk-..."}
                  autoComplete="off"
                  className="min-h-10 w-full min-w-0 rounded-md bg-card px-3 text-[13px] text-foreground shadow-[0_0_0_1px_var(--border)] focus:shadow-[0_0_0_1px_var(--ring),0_0_0_3px_rgba(10,114,239,0.16)] focus:outline-none"
                />
                <small className="text-xs text-muted-foreground">
                  API Key 是模型调用凭据，不是控制台登录方式；保存后不再明文展示。
                </small>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5 rounded-md bg-[#fafafa] p-3 shadow-ring">
              <button
                type="button"
                onClick={runProbe}
                disabled={probing}
                className="inline-flex min-h-[34px] flex-none items-center justify-center rounded-md bg-secondary px-[13px] text-[13px] font-medium text-foreground shadow-ring hover:bg-secondary/80 disabled:opacity-60"
              >
                {probing ? "获取中…" : "获取可用模型"}
              </button>
              <span className="min-w-0 font-mono text-xs text-muted-foreground">
                {fetchStatus}
              </span>
            </div>

            {models.length > 0 ? (
              <div className="grid gap-2 rounded-md bg-[color-mix(in_oklch,var(--ring)_8%,white)] p-3 shadow-[color-mix(in_oklch,var(--ring)_28%,rgba(0,0,0,0.08))_0_0_0_1px]">
                <label
                  htmlFor="codexModel"
                  className="text-[13px] font-semibold text-foreground"
                >
                  选择模型
                </label>
                <Select value={model} onValueChange={setModel}>
                  <SelectTrigger id="codexModel" className="min-h-10 w-full">
                    <SelectValue placeholder="选择一个默认模型" />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <small className="text-xs text-muted-foreground">
                  共 {models.length} 个可用模型；选择一个作为默认模型后才能保存。
                </small>
              </div>
            ) : null}

            <div className="inline-flex w-fit items-center gap-2 rounded-full bg-[#fafafa] px-2.5 py-2 text-xs text-ink-soft shadow-ring">
              <span
                aria-hidden="true"
                className={cn(
                  "size-2 rounded-full",
                  ready
                    ? "bg-success shadow-[0_0_0_4px_color-mix(in_oklch,var(--success)_16%,transparent)]"
                    : "bg-warning shadow-[0_0_0_4px_color-mix(in_oklch,var(--warning)_18%,transparent)]",
                )}
              />
              <span>{loginStateText}</span>
            </div>

            {testResult ? (
              <p
                role="status"
                className={cn(
                  "text-[13px]",
                  testResult.ok ? "text-success" : "text-danger",
                )}
              >
                {testResult.text}
              </p>
            ) : null}
          </div>
          </DialogBody>

          <div className="flex shrink-0 flex-wrap gap-2.5 border-t border-border p-[14px_22px_18px] max-[560px]:grid max-[560px]:grid-cols-1">
            <button
              type="submit"
              disabled={!canSave}
              title={
                !probePassed
                  ? "请先测试 / 获取模型，验证通过后才能保存"
                  : !model.trim()
                    ? "请选择一个默认模型"
                    : undefined
              }
              className="inline-flex min-h-9 items-center justify-center rounded-md bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {saving ? "保存中…" : "保存提供方"}
            </button>
            <button
              type="button"
              onClick={runProbe}
              disabled={probing}
              className="inline-flex min-h-9 items-center justify-center rounded-md bg-secondary px-3.5 text-[13px] font-medium text-foreground shadow-ring hover:bg-secondary/80 disabled:opacity-60"
            >
              {probing ? "测试中…" : "测试凭据"}
            </button>
            <DialogClose className="inline-flex min-h-9 items-center justify-center rounded-md bg-secondary px-3.5 text-[13px] font-medium text-foreground shadow-ring hover:bg-secondary/80">
              取消
            </DialogClose>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
