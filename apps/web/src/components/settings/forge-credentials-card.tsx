/**
 * `ForgeCredentialsCard` — the settings "代码托管连接" card (add-forge-credentials,
 * task 5.2). Lets the operator connect GitHub / GitLab / Gitee with a Personal
 * Access Token so a task can push its edits back + open a PR/MR (and so the repo
 * import picker can list repos). Reads connected state through `forgeCredentialsQuery`
 * (secret-free: kind/host/state/last4 only) and writes via `connectForgeMutation`
 * (PUT /settings/forges, validated server-side) / `disconnectForgeMutation`.
 */
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";

import type { ForgeKind } from "@cap/contracts";
import { forgeCredentialsQuery } from "@/lib/api/queries";
import {
  connectForgeMutation,
  disconnectForgeMutation,
} from "@/lib/api/mutations";
import { StatusPill } from "@/components/status-pill";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

const PUBLIC_HOST: Record<ForgeKind, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  gitee: "gitee.com",
};

const ROWS: ReadonlyArray<{ kind: ForgeKind; label: string; hint: string }> = [
  { kind: "github", label: "GitHub", hint: "需 repo 范围的 PAT" },
  { kind: "gitlab", label: "GitLab", hint: "需 api 范围的 Personal Access Token" },
  { kind: "gitee", label: "Gitee", hint: "需 projects + pull_requests 范围的私人令牌" },
];

export function ForgeCredentialsCard() {
  const queryClient = useQueryClient();
  const forges = useQuery(forgeCredentialsQuery());
  const connect = useMutation(connectForgeMutation(queryClient));
  const disconnect = useMutation(disconnectForgeMutation(queryClient));

  const [dialogKind, setDialogKind] = React.useState<ForgeKind | null>(null);
  const [host, setHost] = React.useState("");
  const [token, setToken] = React.useState("");

  const connected = forges.data ?? [];
  const byKind = (kind: ForgeKind) => connected.find((c) => c.kind === kind);

  function openConnect(kind: ForgeKind) {
    setDialogKind(kind);
    setHost("");
    setToken("");
  }

  function submitConnect() {
    if (!dialogKind || token.trim().length === 0) return;
    connect.mutate(
      { kind: dialogKind, host: host.trim() || undefined, token: token.trim() },
      {
        onSuccess: () => {
          toast.success(`已连接 ${dialogKind}`);
          setDialogKind(null);
        },
        onError: (error) => toast.error(`连接失败：${error.message}`),
      },
    );
  }

  function handleDisconnect(kind: ForgeKind, h: string) {
    disconnect.mutate(
      { kind, host: h },
      {
        onSuccess: () => toast.message(`已断开 ${kind}`),
        onError: (error) => toast.error(`断开失败：${error.message}`),
      },
    );
  }

  return (
    <section className="grid gap-4 rounded-xl bg-card p-5 shadow-ring">
      <div className="grid gap-1">
        <h2 className="m-0 text-[16px] font-semibold text-ink">代码托管连接</h2>
        <p className="m-0 text-[13px] leading-[1.55] text-muted-foreground">
          连接 GitHub / GitLab / Gitee 后，任务完成可把沙箱里的改动推回对应仓库并自动开
          PR / MR。粘贴对应平台的访问令牌（自托管填写实例地址）；保存后仅展示令牌后缀。
        </p>
      </div>

      <div className="grid gap-3">
        {ROWS.map((row) => {
          const cred = byKind(row.kind);
          return (
            <div
              key={row.kind}
              className="flex items-start justify-between gap-3 rounded-lg bg-secondary/40 p-3.5 shadow-ring"
            >
              <div className="grid gap-1">
                <strong className="text-[14px] text-ink">{row.label}</strong>
                <p className="m-0 text-xs text-muted-foreground">{row.hint}</p>
                <Link
                  to="/help/forge-tokens"
                  hash={row.kind}
                  className="mt-0.5 inline-flex w-fit items-center gap-1 text-xs font-medium text-foreground underline decoration-muted-foreground/50 decoration-1 underline-offset-2 hover:decoration-foreground"
                >
                  如何申请令牌？
                  <span aria-hidden className="text-muted-foreground">
                    ↗
                  </span>
                </Link>
              </div>
              {cred ? (
                <div className="flex shrink-0 items-center gap-2">
                  <StatusPill variant="green">
                    已连接 {cred.host}
                    {cred.last4 ? ` ••${cred.last4}` : ""}
                  </StatusPill>
                  <button
                    type="button"
                    disabled={disconnect.isPending}
                    onClick={() => handleDisconnect(row.kind, cred.host)}
                    className="inline-flex h-8 items-center rounded-md bg-card px-3 text-[13px] font-medium text-foreground shadow-ring hover:bg-secondary disabled:opacity-60"
                  >
                    断开
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => openConnect(row.kind)}
                  className="inline-flex h-8 shrink-0 items-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
                >
                  连接
                </button>
              )}
            </div>
          );
        })}
      </div>

      <p className="m-0 text-xs text-muted-foreground">
        令牌按账户加密存储，仅在任务推送 / 开 PR 时解密使用。
      </p>

      <Dialog open={dialogKind !== null} onOpenChange={(o) => !o && setDialogKind(null)}>
        <DialogContent
          showCloseButton
          className="rounded-xl p-0 sm:max-w-[520px]"
          aria-labelledby="forge-connect-title"
        >
          <div className="grid gap-4 p-5">
            <div className="grid gap-1">
              <DialogTitle
                id="forge-connect-title"
                className="text-[18px] font-semibold text-ink"
              >
                连接 {dialogKind ? ROWS.find((r) => r.kind === dialogKind)?.label : ""}
              </DialogTitle>
              <DialogDescription className="text-[13px] leading-[1.55] text-muted-foreground">
                在对应平台创建一个访问令牌并粘贴；自托管请填写实例地址。保存后仅展示后缀。
              </DialogDescription>
              <Link
                to="/help/forge-tokens"
                hash={dialogKind ?? undefined}
                className="inline-flex w-fit items-center gap-1 text-[13px] font-medium text-foreground underline decoration-muted-foreground/50 decoration-1 underline-offset-2 hover:decoration-foreground"
              >
                如何申请{dialogKind ? ROWS.find((r) => r.kind === dialogKind)?.label : ""}令牌？
                <span aria-hidden className="text-muted-foreground">
                  ↗
                </span>
              </Link>
            </div>
            <DialogBody className="grid gap-3.5">
              <label className="grid gap-2">
                <span className="text-[13px] font-semibold text-ink">
                  实例地址（自托管，可选）
                </span>
                <input
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder={dialogKind ? `https://${PUBLIC_HOST[dialogKind]}` : ""}
                  className="min-h-10 w-full rounded-md bg-card px-3 text-sm text-foreground shadow-[inset_0_0_0_1px_var(--border)] outline-none placeholder:text-muted-foreground"
                />
              </label>
              <label className="grid gap-2">
                <span className="text-[13px] font-semibold text-ink">
                  Personal Access Token
                </span>
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="粘贴访问令牌"
                  className="min-h-10 w-full rounded-md bg-card px-3 text-sm text-foreground shadow-[inset_0_0_0_1px_var(--border)] outline-none placeholder:text-muted-foreground"
                />
              </label>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setDialogKind(null)}
                  className="inline-flex h-9 items-center rounded-md bg-card px-4 text-sm font-medium text-foreground shadow-ring hover:bg-secondary"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={connect.isPending || token.trim().length === 0}
                  onClick={submitConnect}
                  className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-60"
                >
                  {connect.isPending ? "连接中…" : "连接"}
                </button>
              </div>
            </DialogBody>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
