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
 *   - the two Codex configuration dialogs (official + compatible).
 *
 * Data wiring (read EXCLUSIVELY through the query factories; settings + codex are
 * MOCK today, non-blocking): the loader ensures `settingsQuery` + `reposQuery` +
 * `codexCredentialQuery` in PARALLEL so the form / picker / status are hydrated
 * before render. `saveSettingsMutation` persists writable prefs (allowedAccount
 * stays read-only — the allowlist governs login); `saveCodexCredentialMutation`
 * persists the execution credential (the plaintext key is dropped to a
 * `hasApiKey` + masked-suffix projection — never re-displayed). Both invalidate
 * their read keys so the UI re-derives.
 *
 * CONCEPT split (never conflated): GitHub OAuth = who may enter the console
 * (read-only identity); the Codex credential = which model the remote Agent runs
 * with. They are managed in distinct sections and never cross-write.
 *
 * SSR-safe: deterministic render off query data; dialog-open + active-tab flags
 * are plain `useState`. No window/clock/random during render or at module scope.
 */
import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { CodexCredentialMode } from "@cap/contracts";
import {
  codexCredentialQuery,
  queryKeys,
  reposQuery,
  settingsQuery,
} from "@/lib/api/queries";
import { isCapable } from "@/lib/api/capabilities";
import {
  saveCodexCredentialMutation,
  saveSettingsMutation,
} from "@/lib/api/mutations";
import { StatusPill } from "@/components/status-pill";
import { SettingsSideNav } from "@/components/settings/settings-side-nav";
import { SystemStrip, SystemTile } from "@/components/settings/system-strip";
import { AccountPanel } from "@/components/settings/account-panel";
import { SettingsForm } from "@/components/settings/settings-form";
import { CodexStatusPanel } from "@/components/settings/codex-status-panel";
import { CodexCredentialWorkspace } from "@/components/settings/codex-tabs";
import { CodexDirectDialog } from "@/components/settings/codex-direct-dialog";
import { CodexApiKeyDialog } from "@/components/settings/codex-api-key-dialog";

export const Route = createFileRoute("/_app/settings")({
  loader: async ({ context }) => {
    // Parallel ensure — no waterfall between settings / repos / credential.
    await Promise.all([
      context.queryClient.ensureQueryData(settingsQuery()),
      context.queryClient.ensureQueryData(reposQuery()),
      context.queryClient.ensureQueryData(codexCredentialQuery()),
    ]);
  },
  component: SettingsPage,
});

function SettingsPage() {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery(settingsQuery());
  const { data: repos } = useQuery(reposQuery());
  const { data: cred } = useQuery(codexCredentialQuery());

  const saveSettings = useMutation(saveSettingsMutation(queryClient));
  const saveCredential = useMutation(saveCodexCredentialMutation(queryClient));

  // Which Codex configuration dialog is open (client-only view state).
  const [dialogMode, setDialogMode] =
    React.useState<CodexCredentialMode | null>(null);

  // Data is loader-ensured; guard for the brief hydration window / mock null.
  if (!settings || !cred) return null;

  const repoList = repos ?? [];
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
          <h1 className="mt-2 max-w-[760px] text-[clamp(24px,3vw,32px)] font-semibold leading-[1.18] tracking-[-0.8px] text-ink">
            账户与模型凭据
          </h1>
          <p className="mt-[7px] max-w-[780px] text-sm leading-[1.58] text-muted-foreground">
            把访问身份、仓库默认值、会话保留和 Agent 模型凭据放在同一个安全面板里管理。
          </p>
        </div>
        <StatusPill variant="green">单用户模式</StatusPill>
      </section>

      {/* settings-page-layout (LEFT side-nav · RIGHT content) */}
      <section className="grid items-start gap-4 min-[1101px]:grid-cols-[230px_minmax(0,1fr)]">
        <SettingsSideNav />

        <div className="grid min-w-0 gap-3.5">
          {/* settings-system-strip */}
          <SystemStrip>
            <SystemTile
              label="ACCOUNT"
              value={login}
              copy="唯一允许进入控制台的 GitHub 身份。"
            />
            <SystemTile
              label="CREDENTIAL"
              value="Agent 模型凭据"
              copy="任务运行时使用的模型访问方式。"
            />
            <SystemTile
              label="SAFETY"
              value="写入前确认"
              copy="危险动作必须在会话里确认。"
            />
          </SystemStrip>

          {/* #account: identity + access/defaults form */}
          <section
            id="account"
            className="grid scroll-mt-24 items-start gap-3.5 min-[981px]:grid-cols-2"
          >
            <AccountPanel login={login} />
            <SettingsForm
              settings={settings}
              repos={repoList}
              saving={saveSettings.isPending}
              onSave={(body) => saveSettings.mutate(body)}
            />
          </section>

          {/* #codex: status + activation workspace */}
          <section
            id="codex"
            className="grid scroll-mt-24 items-start gap-3 min-[961px]:grid-cols-[minmax(260px,0.45fr)_minmax(0,1fr)]"
          >
            <CodexStatusPanel cred={cred} />
            <CodexCredentialWorkspace cred={cred} onConfigure={handleConfigure} />
          </section>
        </div>
      </section>

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
    </>
  );
}
