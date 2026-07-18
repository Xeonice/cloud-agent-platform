/**
 * `McpServerCard` — the "MCP Server" settings section (remote-mcp-server,
 * frontend-console spec "Settings page has an MCP Server section"; track
 * web-settings, task 6.1).
 *
 * Surfaces three things, all wired through the real/mock api seam
 * (`lib/api/queries` + `lib/api/mutations`, gated by the `mcpServer` capability
 * flag — `false`/mock today so the card renders with no live backend):
 *
 *   1. The `mcpServerEnabled` toggle — ADMIN-GATED. Only an admin operator (the
 *      `isAdminSession` role gate the self-update banner already uses)
 *      may flip it; a non-admin sees the current state as a read-only pill with
 *      the switch disabled. The api re-enforces the admin check on write, so a
 *      forced flip still 403s (defense in depth). Off by default; when off the
 *      section shows the server as disabled (no live connect affordance) while an
 *      admin may still enable it.
 *
 *   2. The `/mcp` endpoint URL + connect instructions — paste the minted `mcp_`
 *      token into the MCP client's `Authorization: Bearer` header. The URL is
 *      derived from the configured api origin (guarded so an unset env never
 *      crashes the page).
 *
 *   3. The operator's MCP tokens — mint (a show-once dialog displaying the raw
 *      `mcp_…` token EXACTLY ONCE, the SERVER's one-time mint response, never
 *      client-fabricated), list (prefix + last4 + scopes + lifecycle state, never
 *      the raw/hash), and revoke. The raw token lives only transiently in the
 *      show-once dialog and is never written to a list row.
 *
 * SSR-safe: deterministic render off query data; dialog-open + form flags are
 * plain `useState`; clipboard/`apiBaseUrl()` access is event/guarded, never a
 * window/env read during render.
 */
import * as React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { cn } from "@/utils";
import { apiBaseUrl } from "@/lib/config";
import {
  authSessionQuery,
  mcpServerEnabledQuery,
  mcpTokensQuery,
} from "@/lib/api/queries";
import {
  mintMcpTokenMutation,
  revokeMcpTokenMutation,
  setMcpServerEnabledMutation,
} from "@/lib/api/mutations";
import { isAdminSession } from "@/components/shell/update-banner";
import type {
  McpTokenScope,
  McpTokenSummary,
  MintMcpTokenResponse,
} from "@/lib/api/real";
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
import { useQueryClient } from "@tanstack/react-query";

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/** The MCP-token scopes the mint dialog offers, with a human-readable label. */
export const MCP_TOKEN_SCOPE_OPTIONS: readonly {
  scope: McpTokenScope;
  label: string;
  warning?: string;
}[] = [
  { scope: "tasks:read", label: "tasks:read · 读取任务" },
  { scope: "tasks:write", label: "tasks:write · 创建 / 停止任务" },
  {
    scope: "tasks:diagnostics",
    label: "tasks:diagnostics · 读取任务准备诊断",
    warning: "包含比普通任务状态更深入的准备证据；仅授予受信任的诊断工具。",
  },
  { scope: "repos:read", label: "repos:read · 读取仓库" },
];

/** The default scope selection for a fresh mint (read-only, least privilege). */
export const DEFAULT_MCP_TOKEN_SCOPES: readonly McpTokenScope[] = [
  "tasks:read",
  "repos:read",
];

// ---------------------------------------------------------------------------
// Endpoint URL (guarded — an unset env must NOT crash the settings page)
// ---------------------------------------------------------------------------

/**
 * The canonical `/mcp` endpoint URL to show in the connect instructions, derived
 * from the configured api origin. `apiBaseUrl()` throws when `VITE_API_BASE_URL`
 * is unset — that must not crash the page, so we fall back to a `/mcp` path
 * placeholder the operator can complete with their own origin.
 */
function mcpEndpointUrl(): string {
  try {
    return `${apiBaseUrl()}/mcp`;
  } catch {
    return "/mcp";
  }
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** A token's lifecycle state for the row pill (revoked > expired > active). */
function tokenLifecycle(
  token: McpTokenSummary,
): { label: string; variant: "neutral" | "green" | "danger" | "warn" } {
  if (token.revokedAt) return { label: "已撤销", variant: "danger" };
  if (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now()) {
    return { label: "已过期", variant: "warn" };
  }
  return { label: "有效", variant: "green" };
}

/** A non-secret recognition string for a row: `mcp_…last4`. */
function maskedToken(token: McpTokenSummary): string {
  return `${token.prefix}…${token.last4}`;
}

// ---------------------------------------------------------------------------
// Show-once mint dialog
// ---------------------------------------------------------------------------

function MintDialog({
  open,
  onOpenChange,
  minting,
  onMint,
  minted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  minting: boolean;
  /** Mint with the chosen name + scopes; the parent owns the server call. */
  onMint: (name: string, scopes: McpTokenScope[]) => void;
  /** The show-once mint reply (raw token present), or null before a mint. */
  minted: MintMcpTokenResponse | null;
}) {
  const [name, setName] = React.useState<string>("");
  const [scopes, setScopes] = React.useState<McpTokenScope[]>([
    ...DEFAULT_MCP_TOKEN_SCOPES,
  ]);
  const [copied, setCopied] = React.useState<boolean>(false);

  // Reset transient form state whenever the dialog opens.
  React.useEffect(() => {
    if (open) {
      setName("");
      setScopes([...DEFAULT_MCP_TOKEN_SCOPES]);
      setCopied(false);
    }
  }, [open]);

  function toggleScope(scope: McpTokenScope) {
    setScopes((prev) =>
      prev.includes(scope)
        ? prev.filter((s) => s !== scope)
        : [...prev, scope],
    );
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || scopes.length === 0 || minted) return;
    onMint(name.trim(), scopes);
  }

  async function copyToken() {
    if (!minted?.token) return;
    try {
      await navigator.clipboard.writeText(minted.token);
      setCopied(true);
    } catch {
      // Clipboard may be unavailable; the operator can still select the text.
    }
  }

  const canMint = name.trim().length > 0 && scopes.length > 0 && !minting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-labelledby="mcpMintTitle"
        className="flex max-h-[85vh] flex-col gap-0 overflow-hidden rounded-xl p-0 shadow-modal sm:max-w-[560px]"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 p-[22px_22px_14px]">
          <div className="min-w-0">
            <span className="font-mono text-[11px] font-medium text-muted-foreground">
              MCP Server
            </span>
            <DialogTitle
              id="mcpMintTitle"
              className="mt-1 mb-1.5 text-[22px] font-semibold tracking-[-0.8px] text-ink"
            >
              {minted ? "保存这个 MCP 令牌" : "生成 MCP 令牌"}
            </DialogTitle>
            <DialogDescription className="text-[13px] leading-[1.55] text-muted-foreground">
              {minted
                ? "原始令牌只显示这一次，关闭后将无法再次查看。请立即复制并粘贴到 MCP 客户端的 Authorization 头中。"
                : "为 MCP 客户端生成一个机器凭据，用于驱动平台 API。令牌仅在此处明文展示一次。"}
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
          {minted ? (
            // ----- Show-once reveal (raw token present exactly once) -----
            <div className="grid gap-3.5 p-[0_22px_18px]">
              <div className="grid gap-2 rounded-md bg-[#fafafa] p-3 shadow-ring">
                <span className="text-[13px] font-semibold text-foreground">
                  原始令牌（只显示一次）
                </span>
                <code className="block w-full break-all rounded-md bg-card p-3 font-mono text-[13px] text-foreground shadow-[0_0_0_1px_var(--border)]">
                  {minted.token}
                </code>
                <button
                  type="button"
                  onClick={copyToken}
                  className="inline-flex min-h-9 w-fit items-center justify-center rounded-md bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
                >
                  {copied ? "已复制" : "复制令牌"}
                </button>
              </div>
              <p className="text-xs leading-[1.55] text-muted-foreground">
                把它作为
                <code className="mx-1 rounded bg-secondary px-1 font-mono">
                  Authorization: Bearer {minted.prefix}…
                </code>
                发送给 MCP 客户端。之后列表中只会显示
                <code className="mx-1 rounded bg-secondary px-1 font-mono">
                  {maskedToken(minted)}
                </code>
                。
              </p>
            </div>
          ) : (
            // ----- Mint form (name + scopes) -----
            <form onSubmit={handleSubmit} id="mcpMintForm">
              <div className="grid gap-3.5 p-[0_22px_18px]">
                <div className="grid gap-2">
                  <label
                    htmlFor="mcpTokenName"
                    className="text-[13px] font-semibold text-foreground"
                  >
                    令牌名称
                  </label>
                  <input
                    id="mcpTokenName"
                    name="mcpTokenName"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="例如：Cursor on laptop"
                    autoComplete="off"
                    className="min-h-10 w-full min-w-0 rounded-md bg-card px-3 text-[13px] text-foreground shadow-[0_0_0_1px_var(--border)] focus:shadow-[0_0_0_1px_var(--ring),0_0_0_3px_rgba(10,114,239,0.16)] focus:outline-none"
                  />
                </div>
                <fieldset className="grid gap-2">
                  <legend className="text-[13px] font-semibold text-foreground">
                    权限范围
                  </legend>
                  <div className="grid gap-2">
                    {MCP_TOKEN_SCOPE_OPTIONS.map(({ scope, label, warning }) => (
                      <label
                        key={scope}
                        className="flex items-center gap-2.5 rounded-md bg-[#fafafa] px-3 py-2.5 text-[13px] text-foreground shadow-ring"
                      >
                        <input
                          type="checkbox"
                          checked={scopes.includes(scope)}
                          onChange={() => toggleScope(scope)}
                          className="size-4"
                        />
                        <span className="min-w-0">
                          <span className="block font-mono text-xs">{label}</span>
                          {warning ? (
                            <span className="mt-1 block text-xs leading-[1.45] text-warning">
                              {warning}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    ))}
                  </div>
                  <small className="text-xs text-muted-foreground">
                    至少选择一个范围；令牌仅获得所选范围的权限。
                  </small>
                </fieldset>
              </div>
            </form>
          )}
        </DialogBody>

        <div className="flex shrink-0 flex-wrap gap-2.5 border-t border-border p-[14px_22px_18px] max-[560px]:grid max-[560px]:grid-cols-1">
          {minted ? (
            <DialogClose className="inline-flex min-h-9 items-center justify-center rounded-md bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90">
              我已保存，完成
            </DialogClose>
          ) : (
            <>
              <button
                type="submit"
                form="mcpMintForm"
                disabled={!canMint}
                className="inline-flex min-h-9 items-center justify-center rounded-md bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              >
                {minting ? "生成中…" : "生成令牌"}
              </button>
              <DialogClose className="inline-flex min-h-9 items-center justify-center rounded-md bg-secondary px-3.5 text-[13px] font-medium text-foreground shadow-ring hover:bg-secondary/80">
                取消
              </DialogClose>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// The MCP Server card
// ---------------------------------------------------------------------------

/** The "MCP Server" settings section (toggle + connect info + token card). */
export function McpServerCard() {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(authSessionQuery());
  const { data: enabled } = useQuery(mcpServerEnabledQuery());
  const { data: tokens } = useQuery(mcpTokensQuery());

  const setEnabled = useMutation(setMcpServerEnabledMutation(queryClient));
  const mintToken = useMutation(mintMcpTokenMutation(queryClient));
  const revokeToken = useMutation(revokeMcpTokenMutation(queryClient));

  // Dialog state: open + the (transient) show-once mint reply.
  const [dialogOpen, setDialogOpen] = React.useState<boolean>(false);
  const [minted, setMinted] = React.useState<MintMcpTokenResponse | null>(null);
  const [endpointCopied, setEndpointCopied] = React.useState<boolean>(false);

  const isAdmin = isAdminSession(session ?? undefined);
  const serverOn = enabled === true;
  const endpoint = mcpEndpointUrl();
  const tokenList = tokens ?? [];

  function openMintDialog() {
    setMinted(null);
    setDialogOpen(true);
  }

  function handleDialogOpenChange(open: boolean) {
    setDialogOpen(open);
    // Wipe the show-once reply the moment the dialog closes — the raw token
    // never outlives the dialog (it is never re-fetchable).
    if (!open) setMinted(null);
  }

  function handleMint(name: string, scopes: McpTokenScope[]) {
    mintToken.mutate(
      { name, scopes },
      {
        // The show-once raw token is the SERVER's one-time response, surfaced
        // transiently here and never written to a list row.
        onSuccess: (reply) => setMinted(reply),
      },
    );
  }

  async function copyEndpoint() {
    try {
      await navigator.clipboard.writeText(endpoint);
      setEndpointCopied(true);
    } catch {
      // Clipboard may be unavailable; the operator can still select the text.
    }
  }

  return (
    <Panel className="grid gap-4">
      <PanelHead
        right={
          <StatusPill variant={serverOn ? "green" : "neutral"}>
            {serverOn ? "已启用" : "未启用"}
          </StatusPill>
        }
      >
        <h3 className="text-base font-semibold text-foreground">MCP Server</h3>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          让 MCP 客户端（Cursor / Claude Desktop / VS Code）通过机器令牌驱动平台任务。
        </p>
      </PanelHead>

      {/* Enable toggle — admin-gated. */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-[#fafafa] p-3.5 shadow-ring">
        <div className="min-w-0">
          <strong className="block text-[13px] font-semibold text-foreground">
            启用 MCP Server
          </strong>
          <span className="block text-xs leading-[1.45] text-muted-foreground">
            {isAdmin
              ? "开启后 /mcp 端点开始为已认证的 MCP 令牌提供服务。"
              : "仅管理员可以切换此开关；关闭时 /mcp 端点不提供服务。"}
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={serverOn}
          aria-label="启用 MCP Server"
          disabled={!isAdmin || setEnabled.isPending}
          onClick={() => setEnabled.mutate(!serverOn)}
          className={cn(
            "relative inline-flex h-6 w-11 flex-none items-center rounded-full transition-colors",
            serverOn ? "bg-primary" : "bg-muted-foreground/30",
            (!isAdmin || setEnabled.isPending) && "cursor-not-allowed opacity-60",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "inline-block size-5 transform rounded-full bg-card shadow transition-transform",
              serverOn ? "translate-x-[22px]" : "translate-x-[2px]",
            )}
          />
        </button>
      </div>

      {/* Endpoint URL + connect instructions. */}
      <div
        className={cn(
          "grid gap-2 rounded-md bg-card p-3.5 shadow-ring",
          !serverOn && "opacity-70",
        )}
      >
        <span className="text-[13px] font-semibold text-foreground">
          连接方式
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 break-all rounded-md bg-[#fafafa] px-3 py-2 font-mono text-[13px] text-foreground shadow-ring">
            {endpoint}
          </code>
          <button
            type="button"
            onClick={copyEndpoint}
            className="inline-flex min-h-9 flex-none items-center justify-center rounded-md bg-secondary px-3.5 text-[13px] font-medium text-foreground shadow-ring hover:bg-secondary/80"
          >
            {endpointCopied ? "已复制" : "复制端点"}
          </button>
        </div>
        <p className="text-xs leading-[1.55] text-muted-foreground">
          在 MCP 客户端中把上面这个地址配置为 Streamable HTTP 端点，并把生成的
          <code className="mx-1 rounded bg-secondary px-1 font-mono">mcp_</code>
          令牌放进
          <code className="mx-1 rounded bg-secondary px-1 font-mono">
            Authorization: Bearer &lt;token&gt;
          </code>
          请求头中。
          {!serverOn ? (
            <span className="text-warning"> MCP Server 当前未启用，端点暂不提供服务。</span>
          ) : null}
        </p>
      </div>

      {/* Token card — mint show-once / list prefix+last4 / revoke. */}
      <div className="grid gap-2.5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] font-semibold text-foreground">
            MCP 令牌
          </span>
          <button
            type="button"
            onClick={openMintDialog}
            className="inline-flex min-h-9 items-center justify-center rounded-md bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
          >
            生成令牌
          </button>
        </div>

        {tokenList.length === 0 ? (
          <p className="rounded-md bg-[#fafafa] px-3 py-4 text-center text-[13px] text-muted-foreground shadow-ring">
            还没有 MCP 令牌。生成一个后即可连接 MCP 客户端。
          </p>
        ) : (
          <div className="grid overflow-hidden rounded-md shadow-ring">
            {tokenList.map((token) => {
              const lifecycle = tokenLifecycle(token);
              const revoking =
                revokeToken.isPending && revokeToken.variables === token.id;
              return (
                <div
                  key={token.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-card px-3 py-3 text-[13px] last:border-b-0"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <strong className="truncate font-semibold text-foreground">
                        {token.name}
                      </strong>
                      <StatusPill variant={lifecycle.variant}>
                        {lifecycle.label}
                      </StatusPill>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                      <code className="font-mono">{maskedToken(token)}</code>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono">
                        {token.scopes.join(" ") || "—"}
                      </span>
                    </div>
                  </div>
                  {token.revokedAt ? (
                    <span className="flex-none text-xs text-muted-foreground">
                      已撤销
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => revokeToken.mutate(token.id)}
                      disabled={revoking}
                      className="inline-flex min-h-8 flex-none items-center justify-center rounded-md bg-secondary px-3 text-xs font-medium text-danger shadow-ring hover:bg-secondary/80 disabled:opacity-60"
                    >
                      {revoking ? "撤销中…" : "撤销"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <MintDialog
        open={dialogOpen}
        onOpenChange={handleDialogOpenChange}
        minting={mintToken.isPending}
        onMint={handleMint}
        minted={minted}
      />
    </Panel>
  );
}
