/**
 * `ApiKeysCard` — the "API Keys" management card of the `/settings` page
 * (api-key-machine-identity Track 7 web-settings, task 7.1).
 *
 * Surfaces the three operator-facing API-key operations from the
 * `api-key-auth` spec, all SESSION-authenticated (a session principal carries no
 * scopes → allow-all, so the human operator always sees this card):
 *   - MINT (`POST /api-keys`): a name + a set of scopes + an optional expiry. The
 *     server returns the raw `cap_sk_…` key value EXACTLY ONCE; this card pops a
 *     show-once dialog displaying that raw value (with a copy affordance) and
 *     makes clear it will never be shown again. The server persists only the
 *     SHA-256 hash — the raw key lives only transiently in this dialog's state.
 *   - LIST (`GET /api-keys`): each row shows id/name/scopes plus the display
 *     `prefix`+`last4` (NEVER the raw key or the stored hash), and the
 *     lastUsed / expiry / revoked lifecycle state.
 *   - REVOKE (`DELETE /api-keys/:id`): idempotent; a revoked key stays listed
 *     (showing its revoked timestamp) but stops resolving.
 *
 * This component is PROPS-DRIVEN (mirroring `CodexApiKeyDialog`): the page owns
 * the data read + the mint/revoke mutations and feeds the list + handlers in, so
 * the card itself is a pure view with transient dialog/form state only. The card
 * NEVER fabricates a key value — the show-once raw key is whatever the mint
 * handler resolves with (the server's one-time response).
 *
 * SECURITY: the raw key value is held only in the show-once dialog's `useState`,
 * is wiped when that dialog closes, and is never written to any list row. List
 * rows render `prefix`+`last4` only.
 *
 * SSR-safe: pure render off props; dialog-open / form fields / the just-minted
 * raw key are plain `useState`; the only browser read (clipboard) runs on an
 * explicit click (an event, never during render).
 */
import * as React from "react";
import type { Scope } from "@cap/contracts";

import { cn } from "@/utils";
import { StatusPill } from "@/components/status-pill";
import { Panel, PanelHead } from "@/components/settings/panel";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

// ---------------------------------------------------------------------------
// View types — mirror the Track-2 (`@cap/contracts`) API-key DTOs. Declared
// locally here because the web-settings track is built in isolation from the
// contracts track; the page maps the real contract shapes onto these props.
// ---------------------------------------------------------------------------

/** The canonical shared scope vocabulary (`api-key-auth` spec). */
export type ApiKeyScope = Scope;

/** The selectable scopes, in display order, with operator-facing copy. */
export const API_KEY_SCOPES: readonly {
  value: ApiKeyScope;
  label: string;
  hint: string;
  warning?: string;
}[] = [
  { value: "tasks:read", label: "tasks:read", hint: "读取任务列表与状态" },
  { value: "tasks:write", label: "tasks:write", hint: "创建与停止任务" },
  {
    value: "tasks:diagnostics",
    label: "tasks:diagnostics",
    hint: "读取任务准备阶段的安全诊断时间线",
    warning: "包含比普通任务状态更深入的准备证据；仅授予受信任的诊断工具。",
  },
  { value: "repos:read", label: "repos:read", hint: "读取已导入仓库" },
];

/** Least-privilege defaults for a fresh API key; diagnostics stays opt-in. */
export const DEFAULT_API_KEY_SCOPES: readonly ApiKeyScope[] = ["tasks:read"];

/**
 * A list-item projection of a minted key (the `GET /api-keys` shape). NEVER
 * carries the raw key value or the stored hash — only the display `prefix`,
 * `last4`, and lifecycle timestamps.
 */
export interface ApiKeyListItem {
  id: string;
  name: string;
  scopes: ApiKeyScope[];
  /** The reserved display prefix (`cap_sk_`). */
  prefix: string;
  /** The last 4 characters of the raw key, for disambiguation only. */
  last4: string;
  /** ISO timestamp of last successful resolution, or null if never used. */
  lastUsedAt: string | null;
  /** Absolute expiry, or null for no expiry. */
  expiresAt: string | null;
  /** Revocation timestamp, or null while live. */
  revokedAt: string | null;
}

/** The mint-request payload the card hands to the page's mint handler. */
export interface MintApiKeyRequest {
  name: string;
  scopes: ApiKeyScope[];
  /** Optional absolute expiry as an ISO string. */
  expiresAt?: string;
}

/**
 * The mint RESPONSE — carries the raw key value EXACTLY ONCE alongside its
 * metadata. The card displays `rawKey` in the show-once dialog and never
 * persists it.
 */
export interface MintApiKeyResponse {
  /** The raw `cap_sk_…` key — shown once, never re-fetchable. */
  rawKey: string;
  id: string;
  name: string;
  scopes: ApiKeyScope[];
  prefix: string;
  last4: string;
}

export interface ApiKeysCardProps {
  /** The operator's keys (live + revoked), most-recent-first. */
  keys: ApiKeyListItem[];
  /** Mint a key; resolves with the show-once raw key + metadata. */
  onMint: (body: MintApiKeyRequest) => Promise<MintApiKeyResponse>;
  /** Revoke a key by id (idempotent). */
  onRevoke: (id: string) => Promise<void> | void;
  /** Whether a mint is in flight. */
  minting?: boolean;
  /** The id currently being revoked, if any (disables that row's button). */
  revokingId?: string | null;
}

/** Format an ISO timestamp for a list row; `—` when absent. */
function formatStamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

/** A key is live unless revoked or past its expiry. */
function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const d = new Date(expiresAt);
  return !Number.isNaN(d.getTime()) && d.getTime() <= Date.now();
}

/** The lifecycle pill for a list row (live / expired / revoked). */
function StatePill({ item }: { item: ApiKeyListItem }) {
  if (item.revokedAt) return <StatusPill variant="danger">已撤销</StatusPill>;
  if (isExpired(item.expiresAt))
    return <StatusPill variant="warn">已过期</StatusPill>;
  return <StatusPill variant="green">生效中</StatusPill>;
}

/** One key row in the list. */
function KeyRow({
  item,
  onRevoke,
  revoking,
}: {
  item: ApiKeyListItem;
  onRevoke: (id: string) => void;
  revoking: boolean;
}) {
  const revoked = item.revokedAt != null;
  return (
    <div className="grid gap-2 border-b border-line bg-card px-3.5 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <strong className="truncate text-[13px] font-semibold text-foreground">
            {item.name}
          </strong>
          <StatePill item={item} />
        </div>
        <button
          type="button"
          onClick={() => onRevoke(item.id)}
          disabled={revoked || revoking}
          className="inline-flex min-h-8 flex-none items-center justify-center rounded-md bg-secondary px-3 text-xs font-medium text-foreground shadow-ring hover:bg-secondary/80 disabled:opacity-50"
        >
          {revoked ? "已撤销" : revoking ? "撤销中…" : "撤销"}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded bg-[#fafafa] px-2 py-0.5 font-mono text-[11px] text-muted-foreground shadow-ring">
          {item.prefix}····{item.last4}
        </code>
        {item.scopes.map((s) => (
          <span
            key={s}
            className="inline-flex items-center rounded-full bg-info-soft px-2 py-0.5 font-mono text-[11px] text-info ring-1 ring-inset ring-info/30"
          >
            {s}
          </span>
        ))}
      </div>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground min-[420px]:grid-cols-3">
        <div className="flex gap-1">
          <dt>最近使用</dt>
          <dd className="text-foreground/80">{formatStamp(item.lastUsedAt)}</dd>
        </div>
        <div className="flex gap-1">
          <dt>过期</dt>
          <dd className="text-foreground/80">{formatStamp(item.expiresAt)}</dd>
        </div>
        <div className="flex gap-1">
          <dt>撤销</dt>
          <dd className="text-foreground/80">{formatStamp(item.revokedAt)}</dd>
        </div>
      </dl>
    </div>
  );
}

/** The "API Keys" management card. */
export function ApiKeysCard({
  keys,
  onMint,
  onRevoke,
  minting = false,
  revokingId,
}: ApiKeysCardProps) {
  // Which dialog is open. The show-once dialog is driven by `mintedKey` so it
  // only appears after a successful mint and disappears when the raw key is
  // dismissed (wiping the value).
  const [mintOpen, setMintOpen] = React.useState(false);
  const [mintedKey, setMintedKey] = React.useState<MintApiKeyResponse | null>(
    null,
  );

  // Mint-form state (cleared whenever the mint dialog (re)opens).
  const [name, setName] = React.useState("");
  const [scopes, setScopes] = React.useState<ApiKeyScope[]>([
    ...DEFAULT_API_KEY_SCOPES,
  ]);
  const [expiresAt, setExpiresAt] = React.useState("");
  const [mintError, setMintError] = React.useState<string | null>(null);

  // Copy affordance for the show-once raw key.
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (mintOpen) {
      setName("");
      setScopes([...DEFAULT_API_KEY_SCOPES]);
      setExpiresAt("");
      setMintError(null);
    }
  }, [mintOpen]);

  function toggleScope(scope: ApiKeyScope) {
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  }

  async function handleMint(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || scopes.length === 0 || minting) return;
    setMintError(null);
    const body: MintApiKeyRequest = { name: trimmed, scopes };
    // An empty expiry input means "no expiry"; a value is sent as an ISO string.
    if (expiresAt) {
      const d = new Date(expiresAt);
      if (!Number.isNaN(d.getTime())) body.expiresAt = d.toISOString();
    }
    try {
      const result = await onMint(body);
      // Close the form and reveal the raw key EXACTLY ONCE.
      setMintOpen(false);
      setMintedKey(result);
      setCopied(false);
    } catch {
      setMintError("创建失败，请重试。");
    }
  }

  async function copyRawKey() {
    if (!mintedKey) return;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(mintedKey.rawKey);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    } catch {
      // Clipboard may be unavailable; the key is shown for manual copy anyway.
    }
  }

  function dismissMintedKey() {
    // Closing the show-once dialog WIPES the raw key from memory — it is never
    // recoverable after this point (the server stored only the hash).
    setMintedKey(null);
    setCopied(false);
  }

  const canMint = name.trim().length > 0 && scopes.length > 0 && !minting;

  return (
    <Panel className="grid gap-0">
      <PanelHead
        right={
          <button
            type="button"
            onClick={() => setMintOpen(true)}
            className="inline-flex min-h-8 items-center justify-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            创建 API Key
          </button>
        }
      >
        <h3 className="text-base font-semibold text-foreground">API Keys</h3>
      </PanelHead>

      <p className="mt-[-2px] mb-3 text-[13px] leading-[1.55] text-muted-foreground">
        机器身份凭据：以 <code className="font-mono">cap_sk_</code>{" "}
        开头，绑定到你的账户并带有作用域。创建时只展示一次原始密钥，服务端仅保存其哈希。
      </p>

      {keys.length > 0 ? (
        <div className="grid overflow-hidden rounded-md shadow-ring">
          {keys.map((item) => (
            <KeyRow
              key={item.id}
              item={item}
              onRevoke={(id) => void onRevoke(id)}
              revoking={revokingId === item.id}
            />
          ))}
        </div>
      ) : (
        <div className="grid place-items-center gap-1 rounded-md bg-[#fafafa] p-6 text-center shadow-ring">
          <strong className="text-[13px] text-foreground">
            还没有 API Key
          </strong>
          <span className="text-xs text-muted-foreground">
            创建一个带作用域的密钥，让机器以你的身份调用受控接口。
          </span>
        </div>
      )}

      {/* Mint dialog */}
      <Dialog open={mintOpen} onOpenChange={setMintOpen}>
        <DialogContent
          showCloseButton={false}
          aria-labelledby="apiKeyMintTitle"
          className="flex max-h-[85vh] flex-col gap-0 overflow-hidden rounded-xl p-0 shadow-modal sm:max-w-[560px]"
        >
          <form onSubmit={handleMint} className="flex min-h-0 flex-1 flex-col">
            <header className="flex shrink-0 items-start justify-between gap-4 p-[22px_22px_14px]">
              <div className="min-w-0">
                <span className="font-mono text-[11px] font-medium text-muted-foreground">
                  机器身份
                </span>
                <DialogTitle
                  id="apiKeyMintTitle"
                  className="mt-1 mb-1.5 text-[22px] font-semibold tracking-[-0.8px] text-ink"
                >
                  创建 API Key
                </DialogTitle>
                <DialogDescription className="text-[13px] leading-[1.55] text-muted-foreground">
                  原始密钥仅在创建后展示一次，请妥善保存；之后无法再次查看。
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
                <div className="grid gap-2">
                  <label
                    htmlFor="apiKeyName"
                    className="text-[13px] font-semibold text-foreground"
                  >
                    名称
                  </label>
                  <input
                    id="apiKeyName"
                    name="apiKeyName"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="例如：CI 部署机器人"
                    autoComplete="off"
                    className="min-h-10 w-full min-w-0 rounded-md bg-card px-3 text-[13px] text-foreground shadow-[0_0_0_1px_var(--border)] focus:shadow-[0_0_0_1px_var(--ring),0_0_0_3px_rgba(10,114,239,0.16)] focus:outline-none"
                  />
                </div>

                <fieldset className="grid gap-2">
                  <legend className="text-[13px] font-semibold text-foreground">
                    作用域
                  </legend>
                  <div className="grid gap-2 rounded-md bg-[#fafafa] p-3 shadow-ring">
                    {API_KEY_SCOPES.map((scope) => (
                      <label
                        key={scope.value}
                        className="flex cursor-pointer items-start gap-2.5 text-[13px]"
                      >
                        <input
                          type="checkbox"
                          checked={scopes.includes(scope.value)}
                          onChange={() => toggleScope(scope.value)}
                          className="mt-0.5 size-4 flex-none accent-[var(--primary)]"
                        />
                        <span className="min-w-0">
                          <span className="font-mono text-foreground">
                            {scope.label}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {scope.hint}
                          </span>
                          {scope.warning ? (
                            <span className="mt-1 block text-xs leading-[1.45] text-warning">
                              {scope.warning}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    ))}
                  </div>
                  {scopes.length === 0 ? (
                    <small className="text-xs text-danger">
                      至少选择一个作用域。
                    </small>
                  ) : null}
                </fieldset>

                <div className="grid gap-2">
                  <label
                    htmlFor="apiKeyExpiry"
                    className="text-[13px] font-semibold text-foreground"
                  >
                    过期时间（可选）
                  </label>
                  <input
                    id="apiKeyExpiry"
                    name="apiKeyExpiry"
                    type="datetime-local"
                    value={expiresAt}
                    onChange={(e) => setExpiresAt(e.target.value)}
                    className="min-h-10 w-full min-w-0 rounded-md bg-card px-3 text-[13px] text-foreground shadow-[0_0_0_1px_var(--border)] focus:shadow-[0_0_0_1px_var(--ring),0_0_0_3px_rgba(10,114,239,0.16)] focus:outline-none"
                  />
                  <small className="text-xs text-muted-foreground">
                    留空表示永不过期。
                  </small>
                </div>

                {mintError ? (
                  <p role="status" className="text-[13px] text-danger">
                    {mintError}
                  </p>
                ) : null}
              </div>
            </DialogBody>

            <div className="flex shrink-0 flex-wrap gap-2.5 border-t border-border p-[14px_22px_18px] max-[560px]:grid max-[560px]:grid-cols-1">
              <button
                type="submit"
                disabled={!canMint}
                className="inline-flex min-h-9 items-center justify-center rounded-md bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              >
                {minting ? "创建中…" : "创建并显示密钥"}
              </button>
              <DialogClose className="inline-flex min-h-9 items-center justify-center rounded-md bg-secondary px-3.5 text-[13px] font-medium text-foreground shadow-ring hover:bg-secondary/80">
                取消
              </DialogClose>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Show-once raw-key dialog */}
      <Dialog
        open={mintedKey != null}
        onOpenChange={(open) => {
          if (!open) dismissMintedKey();
        }}
      >
        <DialogContent
          showCloseButton={false}
          aria-labelledby="apiKeyShowTitle"
          className="flex max-h-[85vh] flex-col gap-0 overflow-hidden rounded-xl p-0 shadow-modal sm:max-w-[560px]"
        >
          <header className="flex shrink-0 items-start justify-between gap-4 p-[22px_22px_14px]">
            <div className="min-w-0">
              <span className="font-mono text-[11px] font-medium text-muted-foreground">
                仅显示一次
              </span>
              <DialogTitle
                id="apiKeyShowTitle"
                className="mt-1 mb-1.5 text-[22px] font-semibold tracking-[-0.8px] text-ink"
              >
                保存你的 API Key
              </DialogTitle>
              <DialogDescription className="text-[13px] leading-[1.55] text-muted-foreground">
                这是“{mintedKey?.name}”的原始密钥，现在就复制保存——关闭后将无法再次查看。
              </DialogDescription>
            </div>
          </header>

          <DialogBody>
            <div className="grid gap-3.5 p-[0_22px_18px]">
              <div className="flex flex-wrap items-center gap-2.5 rounded-md bg-[#fafafa] p-3 shadow-ring">
                <code className="min-w-0 flex-1 break-all font-mono text-[13px] text-foreground">
                  {mintedKey?.rawKey}
                </code>
                <button
                  type="button"
                  onClick={copyRawKey}
                  className={cn(
                    "inline-flex min-h-[34px] flex-none items-center justify-center rounded-md px-[13px] text-[13px] font-medium shadow-ring",
                    copied
                      ? "bg-success-soft text-success"
                      : "bg-secondary text-foreground hover:bg-secondary/80",
                  )}
                >
                  {copied ? "已复制" : "复制"}
                </button>
              </div>
              <p className="text-[13px] leading-[1.55] text-warning">
                请立即保存到安全的位置。服务端只保存它的哈希，不会再次明文展示。
              </p>
            </div>
          </DialogBody>

          <div className="flex shrink-0 flex-wrap gap-2.5 border-t border-border p-[14px_22px_18px]">
            <button
              type="button"
              onClick={dismissMintedKey}
              className="inline-flex min-h-9 items-center justify-center rounded-md bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
            >
              我已保存
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </Panel>
  );
}
