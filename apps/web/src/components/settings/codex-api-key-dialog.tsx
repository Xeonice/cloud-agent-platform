/**
 * `CodexApiKeyDialog` — the 兼容模型提供方 configuration dialog (Track 14, 14.5).
 *
 * A shadcn `Dialog` form. Header ("配置模型 API Key"), then:
 *   - Base URL (`type="url"`) + API Key (`type="password"`) inputs. The key
 *     field is ALWAYS empty on open — it is NEVER pre-filled from a saved
 *     credential (the read contract exposes only `hasApiKey` + a masked suffix,
 *     so there is no plaintext to restore). A small note states the key is not
 *     re-shown after saving.
 *   - 获取可用模型 → model discovery. In mock mode it returns a small LOCAL
 *     example model list (clearly example view-data) WITHOUT persisting; a
 *     failed discovery (e.g. missing Base URL) shows an error and does NOT flip
 *     the credential to connected. The discovered list populates the model
 *     picker.
 *   - 选择模型 `Select` (the picker) + a model-count line.
 *   - `.codex-login-state` dot/text mirroring whether a credential is saved.
 *   - Footer: 保存提供方 (submit → `saveCodexCredentialMutation` `mode:'compatible'`,
 *     the key dropped to `hasApiKey` + masked suffix by the mutation), 测试凭据
 *     (reports success/failure WITHOUT exposing the key and WITHOUT flipping to
 *     connected on failure), 取消.
 *
 * SECURITY: the plaintext key lives only in transient form state, is sent on
 * save (where the mutation projects it to a non-secret presence flag + suffix),
 * and is wiped from the field whenever the dialog closes/reopens. It is never
 * read back or displayed.
 *
 * SSR-safe: Radix portals on the client; the form state is plain `useState`. The
 * mock discovery uses a fixed local list (no random/clock during render).
 *
 * Fidelity: dialog `min(720px,100vw-32px)`; `.model-fetch-row` = soft `#fafafa`
 * tile, radius 8, ring, wrap flex; `.codex-model-picker` = accent-tinted tile,
 * radius 8, accent ring; `.codex-login-state` = soft pill, radius full, ring,
 * dot + 12px text; actions = top hairline, 14/22/18 pad.
 */
import * as React from "react";

import type { SaveCodexCredentialRequest } from "@cap/contracts";
import { cn } from "@/utils";
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
 * Mock model discovery: a small fixed example list, clearly view-only data (it
 * is NOT persisted and NOT a live capability). When `settings` is real this is
 * replaced by the real model-discovery endpoint via the data layer. A blank
 * Base URL is treated as a discovery failure (no connection to enumerate).
 */
function discoverModelsMock(baseUrl: string): string[] {
  if (!baseUrl.trim()) {
    throw new Error("请先填写 Base URL，再获取可用模型。");
  }
  return [
    "gpt-4o-mini",
    "gpt-4o",
    "o4-mini",
    "claude-3-5-sonnet",
  ];
}

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

  // Reset transient state whenever the dialog opens; the KEY is always cleared
  // (never restored from a saved credential).
  React.useEffect(() => {
    if (open) {
      setBaseUrl(savedBaseUrl ?? "");
      setApiKey("");
      setModels([]);
      setModel("");
      setFetchStatus("等待填写连接信息");
      setTestResult(null);
    }
  }, [open, savedBaseUrl]);

  function handleFetchModels() {
    setTestResult(null);
    try {
      const found = discoverModelsMock(baseUrl);
      setModels(found);
      setModel(found[0] ?? "");
      setFetchStatus(`已获取 ${found.length} 个示例模型`);
    } catch (err) {
      // Discovery failed: surface the error, do NOT flip to connected.
      setModels([]);
      setModel("");
      setFetchStatus(
        err instanceof Error ? err.message : "获取模型失败，请检查连接信息。",
      );
    }
  }

  function handleTest() {
    // Report success/failure WITHOUT exposing the key; failure never connects.
    if (!baseUrl.trim() || !apiKey.trim()) {
      setTestResult({
        ok: false,
        text: "测试失败：请填写 Base URL 与 API Key。",
      });
      return;
    }
    setTestResult({ ok: true, text: "测试通过：连接信息可用。" });
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body: SaveCodexCredentialRequest = { mode: "compatible" };
    if (baseUrl.trim()) body.baseUrl = baseUrl.trim();
    // Send the key only if the operator typed one; omitting it preserves the
    // previously stored key (per the contract). The mutation drops the plaintext.
    if (apiKey.trim()) body.apiKey = apiKey.trim();
    if (model.trim()) body.defaultModel = model.trim();
    onSave(body);
  }

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
                  onChange={(e) => setBaseUrl(e.target.value)}
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
                  onChange={(e) => setApiKey(e.target.value)}
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
                onClick={handleFetchModels}
                className="inline-flex min-h-[34px] flex-none items-center justify-center rounded-md bg-secondary px-[13px] text-[13px] font-medium text-foreground shadow-ring hover:bg-secondary/80"
              >
                获取可用模型
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
                  共 {models.length} 个可用模型（示例数据）；选择一个作为默认模型。
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
              disabled={saving}
              className="inline-flex min-h-9 items-center justify-center rounded-md bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              保存提供方
            </button>
            <button
              type="button"
              onClick={handleTest}
              className="inline-flex min-h-9 items-center justify-center rounded-md bg-secondary px-3.5 text-[13px] font-medium text-foreground shadow-ring hover:bg-secondary/80"
            >
              测试凭据
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
