/**
 * `SettingsForm` — the "访问与默认值" form (`#github` + `#safety`, task 14.3).
 *
 * The prototype `.panel.settings-form`: a panel-head ("访问与默认值" + a mono
 * "保存到本地状态" note), then five controls and an action row:
 *   1. GitHub 授权白名单 — a READ-ONLY display of the env-managed allowlist
 *      (`AUTH_ALLOWLIST`, GitHub numeric IDs). add-private-account-identity
 *      (task 9.6): GitHub login is ONE of three console login methods; the
 *      allowlist that gates it is governed by the deployment environment
 *      (`AUTH_ALLOWLIST`), NOT editable in the UI — shown read-only with a note
 *      that local accounts are opened on the 账号管理 page (no inline account
 *      management here). It is never submitted (the update contract has no
 *      `allowedAccount` field).
 *   2. 默认仓库 — a `Select` whose options are the imported repos
 *      (`reposQuery`); saving validates the choice references an imported repo.
 *   3. 会话记录保留 — a `Select` over the allowed retention windows (30/7/90 天,
 *      the prototype order), value mirrored from `settingsQuery().retention`.
 *   4. 任务槽位上限 — the SYSTEM-WIDE `maxConcurrentTasks` slot ceiling
 *      (configurable-task-slots): a numeric control client-validated as an
 *      integer in 1–20; an invalid value blocks the submit so it is never sent.
 *      This is one shared value for all allowlisted operators, NOT a per-account
 *      preference.
 *   5. 写入前必须确认 — the `#safety` destructive-write gate checkbox.
 * 保存设置 runs `saveSettingsMutation`; 恢复默认 restores the contract defaults
 * (default repo cleared, retention 30, slot ceiling 5, write-confirm on)
 * WITHOUT auto-saving — matching the prototype's local reset.
 *
 * SECURITY/CONCEPT split: the editable preferences here NEVER touch the console
 * login identity (the GitHub allowlist is read-only/env-managed above; local
 * accounts live on 账号管理) or the Codex execution credential (the `#codex`
 * section). They are distinct concerns and are never conflated.
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
import { StatusPill } from "@/components/status-pill";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Sentinel value for the "no default repo selected" Select option. */
const NO_DEFAULT = "__none__";

/** The retention windows offered, in the prototype's display order. */
const RETENTION_OPTIONS: readonly { value: RetentionDays; label: string }[] = [
  { value: 30, label: "30 天" },
  { value: 7, label: "7 天" },
  { value: 90, label: "90 天" },
];

/** Slot ceiling bounds + default (contracts `maxConcurrentTasks`, 1–20, default 5). */
const SLOT_CEILING_MIN = 1;
const SLOT_CEILING_MAX = 20;
const SLOT_CEILING_DEFAULT = 5;

/** The contract defaults restored by 恢复默认 (matches `DEFAULT_STATE.settings`). */
const DEFAULTS = {
  defaultRepoId: null as string | null,
  retention: 30 as RetentionDays,
  writeConfirm: true,
  maxConcurrentTasks: SLOT_CEILING_DEFAULT,
};

/**
 * Read the system-wide slot ceiling off the settings payload. Structural read
 * (the `maxConcurrentTasks` contract field is optional on the wire), falling
 * back to the backend default 5 when absent or out of the 1–20 integer range.
 */
function readSlotCeiling(settings: AccountSettings): number {
  const value = (settings as { maxConcurrentTasks?: unknown }).maxConcurrentTasks;
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= SLOT_CEILING_MIN &&
    value <= SLOT_CEILING_MAX
    ? value
    : SLOT_CEILING_DEFAULT;
}

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
  // Slot ceiling draft kept as the raw input string so intermediate typing is
  // possible; validated as an integer in 1–20 on submit (never sent invalid).
  const seededSlotCeiling = readSlotCeiling(settings);
  const [slotCeiling, setSlotCeiling] = React.useState<string>(
    String(seededSlotCeiling),
  );
  const [error, setError] = React.useState<string | null>(null);

  // Re-seed if the hydrated settings change underneath (e.g. after a save).
  React.useEffect(() => {
    setDefaultRepoId(settings.defaultRepoId);
    setRetention(settings.retention);
    setWriteConfirm(settings.writeConfirm);
    setSlotCeiling(String(seededSlotCeiling));
  }, [
    settings.defaultRepoId,
    settings.retention,
    settings.writeConfirm,
    seededSlotCeiling,
  ]);

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
    // The slot ceiling MUST be an integer in 1–20; an invalid value blocks the
    // submit entirely so no save request ever carries it.
    const ceiling = Number(slotCeiling);
    if (
      slotCeiling.trim() === "" ||
      !Number.isInteger(ceiling) ||
      ceiling < SLOT_CEILING_MIN ||
      ceiling > SLOT_CEILING_MAX
    ) {
      setError("任务槽位上限必须是 1–20 之间的整数。");
      return;
    }
    setError(null);
    // Built as a variable (not an inline literal) so the system-level
    // `maxConcurrentTasks` rides the request alongside the per-account keys.
    const body = {
      defaultRepoId,
      retention,
      writeConfirm,
      maxConcurrentTasks: ceiling,
    };
    onSave(body);
  }

  function handleReset() {
    setError(null);
    setDefaultRepoId(DEFAULTS.defaultRepoId);
    setRetention(DEFAULTS.retention);
    setWriteConfirm(DEFAULTS.writeConfirm);
    setSlotCeiling(String(DEFAULTS.maxConcurrentTasks));
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

      {/* GitHub 授权白名单 — READ-ONLY, env-managed (AUTH_ALLOWLIST). GitHub login
          is one of three methods; the allowlist that gates it is governed by the
          deployment environment and is NOT editable here. Local accounts are
          opened on the 账号管理 page (no inline account management). */}
      <div className="mb-3.5 grid gap-2">
        <span className={fieldLabel}>GitHub 授权白名单</span>
        <small className={fieldHint}>
          GitHub 登录是进入控制台的方式之一，仅白名单内的账号可通过。名单由部署环境变量{" "}
          <span className="font-mono">AUTH_ALLOWLIST</span>（GitHub 数字
          ID）管理，此处只读展示当前生效项。
        </small>
        <div
          className="flex items-center justify-between gap-3 rounded-md bg-[#fafafa] px-3.5 py-3 shadow-ring"
          aria-readonly="true"
        >
          <div className="min-w-0">
            <strong className="block text-[13px] font-semibold text-foreground">
              {settings.allowedAccount}
            </strong>
            <span className="block font-mono text-xs text-muted-foreground">
              github.com/{settings.allowedAccount}
            </span>
          </div>
          <StatusPill variant="green" className="shrink-0">
            已允许
          </StatusPill>
        </div>
        <small className={fieldHint}>
          修改白名单需更新部署环境变量并重启；本地账号请在左下角账户菜单的「账号管理」页开通。
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

      {/* 任务槽位上限 — SYSTEM-WIDE maxConcurrentTasks (1–20, default 5). */}
      <div className="mb-3.5 grid gap-2">
        <label htmlFor="maxConcurrentTasks" className={fieldLabel}>
          任务槽位上限
        </label>
        <input
          id="maxConcurrentTasks"
          name="maxConcurrentTasks"
          type="number"
          inputMode="numeric"
          min={SLOT_CEILING_MIN}
          max={SLOT_CEILING_MAX}
          step={1}
          value={slotCeiling}
          onChange={(e) => setSlotCeiling(e.target.value)}
          className={fieldControl}
        />
        <small className={fieldHint}>
          系统级共享设置：1–20 之间的整数（默认
          5），所有操作者共用同一个并发任务上限，保存后立即生效。
        </small>
      </div>

      {/* The #safety 写入前必须确认 write-gate section is REMOVED
          (pixel-restore-console-to-od Track 10.1): the agent runs ungated inside
          the sandbox (the trust boundary), so there is no write-confirm toggle.
          `writeConfirm` stays in the persisted shape as a dormant default. */}

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
