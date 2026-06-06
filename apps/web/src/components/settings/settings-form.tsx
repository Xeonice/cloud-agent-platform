/**
 * `SettingsForm` — the "访问与默认值" form (`#github` + `#safety`, task 14.3).
 *
 * The prototype `.panel.settings-form`: a panel-head ("访问与默认值" + a mono
 * "保存到本地状态" note), then four controls and an action row:
 *   1. 允许进入的 GitHub 账号 — a READ-ONLY display of `allowedAccount`. This is
 *      governed by the multi-user-oauth allowlist ("谁能进控制台"), NOT an editable
 *      preference, so the input is rendered `readOnly`/`disabled` and is never
 *      submitted (the update contract has no `allowedAccount` field).
 *   2. 默认仓库 — a `Select` whose options are the imported repos
 *      (`reposQuery`); saving validates the choice references an imported repo.
 *   3. 会话记录保留 — a `Select` over the allowed retention windows (30/7/90 天,
 *      the prototype order), value mirrored from `settingsQuery().retention`.
 *   4. 写入前必须确认 — the `#safety` destructive-write gate checkbox.
 * 保存设置 runs `saveSettingsMutation`; 恢复默认 restores the contract defaults
 * (default repo cleared, retention 30, write-confirm on) WITHOUT auto-saving —
 * matching the prototype's local reset.
 *
 * SECURITY/CONCEPT split: the editable preferences here NEVER touch the OAuth
 * login identity (read-only above) or the Codex execution credential (the
 * `#codex` section). They are three distinct concerns.
 *
 * SSR-safe: the draft is plain `useState` seeded from the (server-hydrated)
 * `settings` prop; no window/clock/random during render.
 *
 * Fidelity (`.field` FINAL): label ink 13/600; input/select white, radius 6,
 * min-h 40, 0/12 pad, 1px ring (focus → accent ring); small muted 12.
 * `.check-row` = soft `#fafafa`, radius 8, ring, 12px pad, top-aligned checkbox.
 * `.action-row` = wrap flex, 12px gap; primary 保存 + secondary 恢复默认.
 */
import * as React from "react";

import type {
  AccountSettings,
  Repo,
  RetentionDays,
  UpdateSettingsRequest,
} from "@cap/contracts";
import { cn } from "@/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";

/** Sentinel value for the "no default repo selected" Select option. */
const NO_DEFAULT = "__none__";

/** The retention windows offered, in the prototype's display order. */
const RETENTION_OPTIONS: readonly { value: RetentionDays; label: string }[] = [
  { value: 30, label: "30 天" },
  { value: 7, label: "7 天" },
  { value: 90, label: "90 天" },
];

/** The contract defaults restored by 恢复默认 (matches `DEFAULT_STATE.settings`). */
const DEFAULTS = {
  defaultRepoId: null as string | null,
  retention: 30 as RetentionDays,
  writeConfirm: true,
};

/** Resolve a repo's `owner/name` display from its gitSource (or fall back). */
function repoFullName(repo: Repo): string {
  const match = repo.gitSource.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1] ?? repo.name;
}

export interface SettingsFormProps {
  /** The server-hydrated account settings (read-only identity + the draft seed). */
  settings: AccountSettings;
  /** The imported repos for the 默认仓库 picker (from `reposQuery`). */
  repos: readonly Repo[];
  /** Whether a save is in flight (disables the submit button). */
  saving?: boolean;
  /** Persist the supplied writable preferences (`saveSettingsMutation`). */
  onSave: (body: UpdateSettingsRequest) => void;
}

/** The shared `.field` label class. */
const fieldLabel = "text-[13px] font-semibold text-foreground";
/** The shared `.field small` class. */
const fieldHint = "text-xs text-muted-foreground";
/** The native `.field` control class (the read-only identity input). */
const fieldControl =
  "min-h-10 w-full min-w-0 rounded-md bg-card px-3 text-[13px] text-foreground shadow-[0_0_0_1px_var(--border)]";

/** The editable access + defaults form. */
export function SettingsForm({
  settings,
  repos,
  saving = false,
  onSave,
}: SettingsFormProps) {
  // Draft seeded from the hydrated settings (allowedAccount stays read-only).
  const [defaultRepoId, setDefaultRepoId] = React.useState<string | null>(
    settings.defaultRepoId,
  );
  const [retention, setRetention] = React.useState<RetentionDays>(
    settings.retention,
  );
  const [writeConfirm, setWriteConfirm] = React.useState<boolean>(
    settings.writeConfirm,
  );
  const [error, setError] = React.useState<string | null>(null);

  // Re-seed if the hydrated settings change underneath (e.g. after a save).
  React.useEffect(() => {
    setDefaultRepoId(settings.defaultRepoId);
    setRetention(settings.retention);
    setWriteConfirm(settings.writeConfirm);
  }, [settings.defaultRepoId, settings.retention, settings.writeConfirm]);

  const importedIds = React.useMemo(
    () => new Set(repos.map((r) => r.id)),
    [repos],
  );

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // A chosen default MUST reference an imported repo (else clear is required).
    if (defaultRepoId !== null && !importedIds.has(defaultRepoId)) {
      setError("默认仓库必须是已导入的仓库；请重新选择或清除默认值。");
      return;
    }
    setError(null);
    onSave({ defaultRepoId, retention, writeConfirm });
  }

  function handleReset() {
    setError(null);
    setDefaultRepoId(DEFAULTS.defaultRepoId);
    setRetention(DEFAULTS.retention);
    setWriteConfirm(DEFAULTS.writeConfirm);
  }

  return (
    <form
      id="github"
      onSubmit={handleSubmit}
      className="grid min-w-0 scroll-mt-24 rounded-md bg-card p-[18px] shadow-ring"
    >
      <div className="m-[-18px_-18px_14px] flex min-h-10 items-center justify-between gap-3 rounded-t-md border-b border-border bg-[#fafafa] px-[18px] py-2.5">
        <h3 className="text-base font-semibold text-foreground">访问与默认值</h3>
        <span className="font-mono text-xs text-muted-foreground">
          保存到本地状态
        </span>
      </div>

      {/* 允许进入的 GitHub 账号 — READ-ONLY (governed by the allowlist). */}
      <div className="mb-3.5 grid gap-2">
        <label htmlFor="allowedAccount" className={fieldLabel}>
          允许进入的 GitHub 账号
        </label>
        <input
          id="allowedAccount"
          name="allowedAccount"
          value={settings.allowedAccount}
          readOnly
          aria-readonly="true"
          autoComplete="off"
          className={cn(fieldControl, "cursor-not-allowed text-muted-foreground")}
        />
        <small className={fieldHint}>
          只有这个 GitHub OAuth 账号可以进入控制台；没有公开注册入口。
        </small>
      </div>

      {/* 默认仓库 — Select over imported repos. */}
      <div className="mb-3.5 grid gap-2">
        <label htmlFor="defaultRepo" className={fieldLabel}>
          默认仓库
        </label>
        <Select
          value={defaultRepoId ?? NO_DEFAULT}
          onValueChange={(v) =>
            setDefaultRepoId(v === NO_DEFAULT ? null : v)
          }
        >
          <SelectTrigger id="defaultRepo" className="min-h-10 w-full">
            <SelectValue placeholder="选择默认仓库" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_DEFAULT}>不设置默认仓库</SelectItem>
            {repos.map((repo) => (
              <SelectItem key={repo.id} value={repo.id}>
                {repoFullName(repo)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <small className={fieldHint}>
          新建任务时优先选中这个仓库；仓库列表由“仓库导入”页面维护。
        </small>
      </div>

      {/* 会话记录保留 — Select over the retention windows. */}
      <div className="mb-3.5 grid gap-2">
        <label htmlFor="retention" className={fieldLabel}>
          会话记录保留
        </label>
        <Select
          value={String(retention)}
          onValueChange={(v) => setRetention(Number(v) as RetentionDays)}
        >
          <SelectTrigger id="retention" className="min-h-10 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RETENTION_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={String(option.value)}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <small className={fieldHint}>
          影响历史日志和 CLI 会话记录的默认保留周期。
        </small>
      </div>

      {/* 写入前必须确认 — the #safety destructive-write gate. */}
      <label
        id="safety"
        className="flex scroll-mt-24 items-start gap-2.5 rounded-md bg-[#fafafa] p-3 shadow-ring"
      >
        <Checkbox
          checked={writeConfirm}
          onCheckedChange={(c) => setWriteConfirm(c === true)}
          name="writeConfirm"
          className="mt-0.5"
        />
        <span>
          <strong className="text-[13px] font-semibold text-foreground">
            写入前必须确认
          </strong>
          <br />
          <small className="text-xs text-muted-foreground">
            Commit、push、secret 变更和 GitHub PR 创建前暂停，等待操作者确认。
          </small>
        </span>
      </label>

      {error ? (
        <p role="alert" className="mt-3 text-[13px] text-danger">
          {error}
        </p>
      ) : null}

      <div className="mt-7 flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={saving}
          className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          保存设置
        </button>
        <button
          type="button"
          onClick={handleReset}
          className="inline-flex h-9 items-center justify-center rounded-md bg-secondary px-3.5 text-[13px] font-medium text-foreground shadow-ring hover:bg-secondary/80"
        >
          恢复默认
        </button>
      </div>
    </form>
  );
}
