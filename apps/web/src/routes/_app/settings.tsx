/**
 * `/settings` — 设置 · 账户与模型凭据 (app-shell, SSR; Track 14
 * fe-page-repositories-settings, tasks 14.3 + 14.4 + 14.5).
 *
 * The page BODY rendered inside the `_app` shell `<Outlet/>` (sidebar / topbar /
 * mobile-nav already exist — this route does NOT rebuild the shell). Composes,
 * faithfully to the `settings.html` prototype:
 *   - screen-header (eyebrow 设置 / h1 账户与模型凭据 / lead + green 单用户模式 pill);
 *   - a 2-col `settings-page-layout`: LEFT `SettingsSideNav` (4 anchor links),
 *     RIGHT the content column —
 *       · the 3-up `SystemStrip` (ACCOUNT / CREDENTIAL / SAFETY),
 *       · `#account`: the read-only `AccountPanel` + the editable `SettingsForm`
 *         (`#github` + `#safety`),
 *       · `#codex`: the `CodexStatusPanel` + the `CodexCredentialWorkspace`;
 *       · `#api-keys`: the `ApiKeysCard` (mint show-once / list / revoke);
 *   - the two Codex configuration dialogs (official + compatible).
 *
 * Data wiring (read EXCLUSIVELY through the query factories): the loader ensures
 * `settingsQuery` + `reposQuery` + `codexCredentialQuery` + `apiKeysQuery` in
 * PARALLEL so the form / picker / status / key list are hydrated before render.
 * `saveSettingsMutation` persists writable prefs (allowedAccount stays read-only);
 * `saveCodexCredentialMutation` persists the
 * execution credential (the plaintext key is dropped to a `hasApiKey` +
 * masked-suffix projection — never re-displayed). `mintApiKeyMutation` /
 * `revokeApiKeyMutation` go through the real/mock seam (api-key-machine-identity):
 * the show-once raw key is the SERVER's one-time response, and both invalidate
 * `apiKeys` so the card's list re-derives.
 *
 * CONCEPT split (never conflated): the console account = who may enter the
 * console; the runtime credential = which model the remote Agent runs with; an
 * API key = a machine credential to drive the platform's own API. They are
 * managed in distinct sections and never cross-write.
 *
 * SSR-safe: deterministic render off query data; dialog-open + active-tab flags
 * are plain `useState`. No window/clock/random during render or at module scope.
 */
import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  AuthSession,
  ClaudeCredentialMode,
  CodexCredentialMode,
} from "@cap/contracts";
import {
  apiKeysQuery,
  authSessionQuery,
  claudeCredentialQuery,
  codexCredentialQuery,
  forgeCredentialsQuery,
  mcpServerEnabledQuery,
  mcpTokensQuery,
  queryKeys,
  reposQuery,
  sandboxEnvironmentsQuery,
  settingsQuery,
  smtpConfigQuery,
} from "@/lib/api/queries";
import { isCapable } from "@/lib/api/capabilities";
import {
  mintApiKeyMutation,
  revokeApiKeyMutation,
  saveClaudeCredentialMutation,
  saveCodexCredentialMutation,
  saveSettingsMutation,
} from "@/lib/api/mutations";
import { ClaudeCredentialDialog } from "@/components/settings/claude-credential";
import { RuntimeCredentialTabs } from "@/components/settings/runtime-credentials";
import { StatusPill } from "@/components/status-pill";
import { AccountPanel } from "@/components/settings/account-panel";
import { SettingsForm } from "@/components/settings/settings-form";
import { CodexDirectDialog } from "@/components/settings/codex-direct-dialog";
import { CodexApiKeyDialog } from "@/components/settings/codex-api-key-dialog";
import { ApiKeysCard } from "@/components/settings/api-keys-card";
import { McpServerCard } from "@/components/settings/mcp-server-card";
import { ForgeCredentialsCard } from "@/components/settings/forge-credentials-card";
import { SmtpConfigCard } from "@/components/settings/smtp-config-card";
import { isAdminSession } from "@/components/shell/update-banner";

export const Route = createFileRoute("/_app/settings")({
  loader: async ({ context }) => {
    // Parallel ensure — no waterfall between settings / repos / credential / keys /
    // MCP-server flag + tokens (remote-mcp-server, web-settings track).
    await Promise.all([
      context.queryClient.ensureQueryData(settingsQuery()),
      context.queryClient.ensureQueryData(reposQuery()),
      context.queryClient.ensureQueryData(sandboxEnvironmentsQuery()),
      context.queryClient.ensureQueryData(codexCredentialQuery()),
      context.queryClient.ensureQueryData(claudeCredentialQuery()),
      context.queryClient.ensureQueryData(apiKeysQuery()),
      context.queryClient.ensureQueryData(mcpServerEnabledQuery()),
      context.queryClient.ensureQueryData(forgeCredentialsQuery()),
      context.queryClient.ensureQueryData(mcpTokensQuery()),
      // SMTP config (add-smtp-config-ui) — the admin-only Resend section reads
      // the masked config + the session (for the admin gate) through the seam.
      context.queryClient.ensureQueryData(smtpConfigQuery()),
      context.queryClient.ensureQueryData(authSessionQuery()),
    ]);
  },
  component: SettingsPage,
});

function SettingsPage() {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery(settingsQuery());
  const { data: repos } = useQuery(reposQuery());
  const { data: sandboxEnvironments } = useQuery(sandboxEnvironmentsQuery());
  const { data: cred } = useQuery(codexCredentialQuery());
  const { data: claudeCred } = useQuery(claudeCredentialQuery());
  const { data: apiKeys } = useQuery(apiKeysQuery());
  // The SMTP section is admin-only (UX gate; the api re-enforces admin on every
  // SMTP endpoint regardless). Read the session for `isAdminSession`.
  const { data: session } = useQuery(authSessionQuery());
  const isAdmin = shouldShowAdminSettingsSections(session ?? undefined);

  const saveSettings = useMutation(saveSettingsMutation(queryClient));
  const saveCredential = useMutation(saveCodexCredentialMutation(queryClient));
  const saveClaude = useMutation(saveClaudeCredentialMutation(queryClient));
  // API-key mint/revoke through the real/mock seam (api-key-machine-identity).
  // The show-once raw key is the SERVER's one-time mint response — never a
  // client-fabricated value — and both invalidate `apiKeys` so the list refreshes.
  const mintApiKey = useMutation(mintApiKeyMutation(queryClient));
  const revokeApiKey = useMutation(revokeApiKeyMutation(queryClient));

  // Which Codex configuration dialog is open (client-only view state).
  const [dialogMode, setDialogMode] =
    React.useState<CodexCredentialMode | null>(null);
  // Which Claude Code configuration dialog is open (client-only view state).
  const [claudeDialogMode, setClaudeDialogMode] =
    React.useState<ClaudeCredentialMode | null>(null);

  // Data is loader-ensured; guard for the brief hydration window / mock null.
  if (!settings || !cred) return null;

  const repoList = repos ?? [];
  const readySandboxEnvironments = (
    sandboxEnvironments?.environments ?? []
  ).filter((environment) => environment.status === "ready");
  const login = settings.allowedAccount;

  function handleConfigure(mode: CodexCredentialMode) {
    setDialogMode(mode);
  }

  return (
    <>
      {/* screen-header */}
      <section className="mb-[18px] grid items-end gap-4 min-[821px]:grid-cols-[minmax(0,1fr)_auto]">
        <div>
          <div className="font-mono text-xs font-semibold text-muted-foreground">
            设置
          </div>
          <h1 className="max-w-[880px] text-[clamp(24px,3vw,32px)] font-semibold leading-[1.18] tracking-[-0.8px] text-ink">
            账户与模型凭据
          </h1>
          <p className="mt-[7px] max-w-[820px] text-sm leading-[1.58] text-muted-foreground">
            把访问身份、仓库与镜像默认值、会话保留和 Agent 模型凭据放在同一个安全面板里管理。
          </p>
        </div>
        <StatusPill variant="green">单用户模式</StatusPill>
      </section>

      {/* settings-stack — single-column layout, max 640px (pixel-restore Track
          10.1; matches design-baseline `.settings-stack`: no side-nav, no
          system-strip, panels stacked at 24px gap). */}
      <div className="grid max-w-[640px] gap-6">
        {/* #account: identity + access/defaults form, stacked */}
        <section id="account" className="grid scroll-mt-24 gap-6">
          <AccountPanel login={login} />
          <SettingsForm
            settings={settings}
            repos={repoList}
            sandboxEnvironments={readySandboxEnvironments}
            saving={saveSettings.isPending}
            onSave={(body) => saveSettings.mutate(body)}
          />
        </section>

        {/* Agent 模型凭据 — ONE section with runtime tabs (Codex | Claude Code),
            each runtime's provider entries below (Track 10.2, baseline #codex). */}
        <RuntimeCredentialTabs
          codexCred={cred}
          claudeCred={
            claudeCred ?? {
              mode: "subscription",
              state: "not_connected",
              hasSetupToken: false,
              hasApiKey: false,
            }
          }
          onConfigureCodex={handleConfigure}
          onConfigureClaude={setClaudeDialogMode}
        />

        {/* #forges: code-hosting (forge) connection — connect a GitHub/GitLab/Gitee
            PAT so a completed task can push back + open a PR/MR (add-forge-credentials). */}
        <section id="forges" className="grid scroll-mt-24 gap-3">
          <ForgeCredentialsCard />
        </section>

        {/* #api-keys: machine-identity credentials (mint show-once / list / revoke) */}
        <section id="api-keys" className="grid scroll-mt-24 gap-3">
            <ApiKeysCard
              keys={apiKeys?.keys ?? []}
              onMint={async (body) => {
                const minted = await mintApiKey.mutateAsync(body);
                // The card's show-once dialog reads `rawKey`; the server returns
                // it as `key` (the only time it is ever transmitted).
                return {
                  rawKey: minted.key,
                  id: minted.id,
                  name: minted.name,
                  scopes: minted.scopes,
                  prefix: minted.prefix,
                  last4: minted.last4,
                };
              }}
              onRevoke={(id) => revokeApiKey.mutateAsync(id)}
              minting={mintApiKey.isPending}
              revokingId={
                revokeApiKey.isPending ? (revokeApiKey.variables ?? null) : null
              }
            />
          </section>

          {/* #mcp: the remote MCP server surface — admin-gated enable toggle,
              /mcp endpoint + connect instructions, and the MCP-token card (mint
              show-once / list prefix+last4 / revoke). Self-contained: it reads
              the real/mock api seam internally (gated by the `mcpServer`
              capability flag). */}
        <section id="mcp" className="grid scroll-mt-24 gap-3">
          <McpServerCard />
        </section>

        {/* #smtp: the admin-only 邮件发送（Resend）section — masked status +
            a Resend-shaped config dialog (API Key + sender) + 发送测试 + a
            Resend help link (add-smtp-config-ui). Mounted admin-only; the api
            independently enforces admin on every SMTP endpoint. */}
        {isAdmin ? (
          <section id="smtp" className="grid scroll-mt-24 gap-3">
            <SmtpConfigCard />
          </section>
        ) : null}
      </div>

      {/* Codex configuration dialogs */}
      <CodexDirectDialog
        open={dialogMode === "official"}
        onOpenChange={(open) => setDialogMode(open ? "official" : null)}
        connected={cred.mode === "official" && cred.state === "connected"}
        login={login}
        capable={isCapable("settings")}
        onConnected={() => {
          // The device login stored the credential server-side; refresh the read
          // so the panel flips to connected. Keep the dialog OPEN so it can show
          // the "✓ 已连接" affirmation; the operator closes it with 完成.
          void queryClient.invalidateQueries({
            queryKey: queryKeys.codexCredential,
          });
        }}
      />
      <CodexApiKeyDialog
        open={dialogMode === "compatible"}
        onOpenChange={(open) => setDialogMode(open ? "compatible" : null)}
        hasSavedKey={cred.mode === "compatible" && cred.hasApiKey}
        savedKeySuffix={cred.mode === "compatible" ? cred.apiKeySuffix : null}
        savedBaseUrl={cred.mode === "compatible" ? cred.baseUrl : null}
        saving={saveCredential.isPending}
        onSave={(body) =>
          saveCredential.mutate(body, {
            onSuccess: () => setDialogMode(null),
          })
        }
      />

      {/* Claude Code configuration dialog (mode-aware: setup-token / API key) */}
      <ClaudeCredentialDialog
        open={claudeDialogMode !== null}
        mode={claudeDialogMode ?? "subscription"}
        saving={saveClaude.isPending}
        onOpenChange={(open) => {
          if (!open) setClaudeDialogMode(null);
        }}
        onSave={(body) =>
          saveClaude.mutate(body, {
            onSuccess: () => setClaudeDialogMode(null),
          })
        }
      />
    </>
  );
}

export function shouldShowAdminSettingsSections(
  session: AuthSession | undefined,
): boolean {
  return isAdminSession(session);
}
