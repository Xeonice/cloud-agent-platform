/**
 * `UpdateBanner` — the dismissible "update available" strip (update-availability-
 * check, Phase 2 of the OSS self-update epic; tasks 3.2 / 3.3).
 *
 * Reads the cached, server-side update check through the standard query seam
 * (`updateStatusQuery` → `BACKEND_CAPABILITIES.updateCheck`: `real.getUpdateStatus`
 * when capable, the typed `mockUpdateStatus` otherwise), so it renders on the
 * mock until the live `GET /update-status` is verified, then ONE flag flip
 * repoints it. The banner is shown ONLY when the check honestly reports
 * `updateAvailable` with a known newer version — a source build / no releases /
 * fetch failure all degrade to `updateAvailable: false`, so nothing renders and
 * no prompt is ever fabricated (design D2/D4).
 *
 * Dismissal is PER-VERSION: dismissing the banner persists the dismissed version
 * to `localStorage`; the banner stays hidden for that exact version but
 * re-surfaces the moment a strictly different (newer) version is offered. The
 * show/hide decision is factored into the pure {@link selectBannerView} so the
 * "appears on available / absent otherwise / dismissal is per-version" contract
 * is unit-testable without a DOM.
 *
 * SSR-safe: the dismissed-version read uses `useSyncExternalStore` with a
 * deterministic server snapshot (`null` — nothing dismissed), and the first
 * client snapshot stays reference-stable until hydration reads `localStorage`,
 * so there is no hydration tearing. `window` is never touched during render on
 * the server.
 */
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpCircle, Loader2, X } from "lucide-react";

import type { AuthSession, UpdateStatus } from "@cap/contracts";
import { authSessionQuery, updateStatusQuery } from "@/lib/api/queries";
import { isCapable } from "@/lib/api/capabilities";
import { selfUpdateMutation } from "@/lib/api/mutations";
import { apiBaseUrl } from "@/lib/config";
import { cn } from "@/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * The `localStorage` key the dismissed version is persisted under. Namespaced
 * away from the main UI `store` (which this banner deliberately does not touch)
 * so dismissal is a self-contained banner concern.
 */
export const DISMISSED_UPDATE_VERSION_KEY = "cap.updateBanner.dismissedVersion";

/** The minimal view the banner renders when an update should be surfaced. */
export interface UpdateBannerView {
  /** The newer version to advertise (the latest release tag, e.g. `v0.4.0`). */
  version: string;
  /** The changelog/release link, when the check supplied one (else `null`). */
  releaseUrl: string | null;
  /** A human release name to show, when present (else falls back to the version). */
  releaseName: string | null;
}

/**
 * Pure show/hide decision (design D2/D4). Returns the banner view ONLY when the
 * check reports an available update for a KNOWN latest version that has not been
 * dismissed; returns `null` (banner hidden) in every other case:
 *   - `updateAvailable` is `false` (up-to-date / unknown current / no releases /
 *     fetch failure — the api already collapsed all of these honestly),
 *   - `latestVersion` is `null` (no concrete version to advertise),
 *   - the latest version EQUALS the dismissed version (per-version dismissal).
 *
 * Per-version dismissal falls out naturally: a later, different `latestVersion`
 * is `!== dismissedVersion`, so it re-surfaces even though an older one was
 * dismissed. Pure (no `window`, no React), so it is trivially unit-testable.
 */
export function selectBannerView(
  status: UpdateStatus | undefined,
  dismissedVersion: string | null,
): UpdateBannerView | null {
  if (!status) return null;
  if (!status.updateAvailable) return null;
  const version = status.latestVersion;
  if (!version) return null;
  if (dismissedVersion !== null && dismissedVersion === version) return null;
  return {
    version,
    releaseUrl: status.releaseUrl,
    releaseName: status.releaseName,
  };
}

/**
 * Whether the resolved auth session belongs to an admin operator. The UI gate is
 * convenience only — the api re-enforces the role check server-side on admin
 * routes. A `null`/unresolved session or disabled account is never an admin.
 */
export function isAdminSession(session: AuthSession | undefined): boolean {
  if (!session) return false;
  if (!session.allowed) return false;
  return session.role === "admin";
}

// ---------------------------------------------------------------------------
// Upgrade-action gate (self-update-action D1/D2) — pure show/hide decision
// ---------------------------------------------------------------------------

/**
 * Pure decision for whether the admin-gated "Upgrade to vY" action is present
 * (self-update-action task 2.2/2.3). Returns `true` ONLY when ALL three hold:
 *   - self-update is ENABLED (the `selfUpdate` capability flag — off by default,
 *     so the shipped posture never shows the action; design D1/D5),
 *   - the operator is an ADMIN (design D2), and
 *   - an update is genuinely AVAILABLE (a non-null banner view — i.e. a known
 *     newer, non-dismissed version; reuses {@link selectBannerView}).
 *
 * Returns `false` otherwise, so the banner stays NOTIFY-ONLY (Phase 2 behavior)
 * whenever self-update is off / the operator is not an admin / no update is
 * available. Pure (no `window`, no React, no network), so the four-way matrix is
 * directly unit-testable.
 */
export function selectUpgradeAction(
  view: UpdateBannerView | null,
  opts: { selfUpdateEnabled: boolean; isAdmin: boolean },
): boolean {
  if (!view) return false;
  if (!opts.selfUpdateEnabled) return false;
  if (!opts.isAdmin) return false;
  return true;
}

/**
 * Whether two version tags name the same release, tolerant ONLY of a leading `v`
 * (so `/version`'s `v0.3.2` matches a `0.3.2`/`v0.3.2` target). Used to detect when
 * the recreated api has come back on the upgrade target. Pure → unit-testable.
 */
export function sameTag(a: string, b: string): boolean {
  const strip = (s: string): string => s.trim().replace(/^v/i, "");
  return strip(a) === strip(b) && strip(a).length > 0;
}

// ---------------------------------------------------------------------------
// Dismissed-version external store (SSR-safe, localStorage-backed)
// ---------------------------------------------------------------------------

const dismissListeners = new Set<() => void>();
let dismissCache: string | null = null;
let dismissHydrated = false;

function readDismissed(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(DISMISSED_UPDATE_VERSION_KEY);
  } catch {
    return null;
  }
}

function subscribeDismissed(onChange: () => void): () => void {
  // Hydrate from localStorage on the first client subscription so the SSR
  // snapshot (`null`) and the first client snapshot stay reference-equal until
  // real hydration, avoiding a tearing warning.
  if (!dismissHydrated && typeof window !== "undefined") {
    dismissHydrated = true;
    dismissCache = readDismissed();
  }
  dismissListeners.add(onChange);
  return () => {
    dismissListeners.delete(onChange);
  };
}

function getDismissedSnapshot(): string | null {
  return dismissCache;
}

function getDismissedServerSnapshot(): string | null {
  return null;
}

// ---------------------------------------------------------------------------
// In-flight upgrade target (sessionStorage) — so a page refresh MID-UPGRADE
// resumes the version poll + "updating…" state instead of dropping it. Per-tab
// (sessionStorage) so it auto-clears when the tab closes and never goes stale
// across sessions; cleared on completion/timeout.
// ---------------------------------------------------------------------------

const UPGRADE_TARGET_KEY = "cap-self-update-target";

function readUpgradeTarget(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(UPGRADE_TARGET_KEY);
  } catch {
    return null;
  }
}

function writeUpgradeTarget(target: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (target) window.sessionStorage.setItem(UPGRADE_TARGET_KEY, target);
    else window.sessionStorage.removeItem(UPGRADE_TARGET_KEY);
  } catch {
    /* storage unavailable — degrade to non-resumable polling */
  }
}

/** Persist the dismissed version and notify subscribers (client-only write). */
function setDismissedVersion(version: string): void {
  dismissCache = version;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(DISMISSED_UPDATE_VERSION_KEY, version);
    } catch {
      // Ignore quota / unavailable storage — the in-memory cache still hides it
      // for this session.
    }
  }
  for (const fn of dismissListeners) fn();
}

/** The currently-dismissed update version, or `null`. SSR-safe. */
function useDismissedVersion(): string | null {
  return React.useSyncExternalStore(
    subscribeDismissed,
    getDismissedSnapshot,
    getDismissedServerSnapshot,
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface UpdateBannerProps {
  /** Optional extra classes for the wrapping strip. */
  className?: string;
}

/**
 * The slim, dismissible app-shell strip. Renders nothing unless the check
 * reports an available, non-dismissed update (see {@link selectBannerView}).
 *
 * When self-update is ENABLED (the `selfUpdate` capability flag) AND the operator
 * is an ADMIN (read from the auth session INSIDE the banner — `_app.tsx` renders
 * `<UpdateBanner/>` with no props and is untouched) the strip additionally offers
 * an "Upgrade to vY" action (self-update-action task 2.2). Clicking it opens a
 * confirmation dialog carrying an explicit HOST-ROOT warning; only after explicit
 * confirmation does it `POST /self-update`, after which the banner shows an
 * "updating… reconnecting" state while the api recreates itself via the detached
 * updater and the existing WS auto-reconnect resumes the session (design D4).
 * With self-update off / a non-admin / no update, the action is ABSENT and the
 * banner stays notify-only (Phase 2 behavior).
 */
export function UpdateBanner({ className }: UpdateBannerProps) {
  const { data: status } = useQuery(updateStatusQuery());
  const { data: session } = useQuery(authSessionQuery());
  const dismissedVersion = useDismissedVersion();
  const queryClient = useQueryClient();
  const upgrade = useMutation(selfUpdateMutation(queryClient));
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [upgradeDone, setUpgradeDone] = React.useState(false);
  // The persisted in-flight upgrade target (sessionStorage), so a page refresh
  // MID-UPGRADE resumes the poll + "updating…" state. Hydrated in an effect (not
  // during render) to stay SSR-safe, like the dismissed-version store above.
  const [persistedTarget, setPersistedTarget] = React.useState<string | null>(null);
  React.useEffect(() => {
    setPersistedTarget(readUpgradeTarget());
  }, []);
  // On a successful ack, persist the target so a refresh can resume the poll.
  React.useEffect(() => {
    const acked = upgrade.isSuccess ? (upgrade.data?.target ?? null) : null;
    if (acked) {
      writeUpgradeTarget(acked);
      setPersistedTarget(acked);
    }
  }, [upgrade.isSuccess, upgrade.data?.target]);

  // The active upgrade target: this session's ack OR a persisted in-flight upgrade
  // (resumed after a refresh). After the ack the api recreates itself (down, then up
  // on the new version); poll the PUBLIC `/version` until it reports the target, then
  // surface a "done" state and reload so the (possibly new) console bundle + cleared
  // banner load. The poll tolerates the api being unreachable mid-recreate (caught →
  // keep polling), CLEARS the persisted marker on completion/timeout, and is bounded
  // so it never spins forever. Hooks run BEFORE the `!view` early return below.
  const target = upgrade.data?.target ?? persistedTarget;
  React.useEffect(() => {
    if (!target) return;
    let cancelled = false;
    const startedAt = Date.now();
    const TIMEOUT_MS = 5 * 60_000;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async (): Promise<void> => {
      if (cancelled) return;
      try {
        const res = await fetch(`${apiBaseUrl()}/version`, { cache: "no-store" });
        if (res.ok) {
          const body = (await res.json()) as { version?: string };
          if (body.version && sameTag(body.version, target)) {
            writeUpgradeTarget(null); // clear BEFORE reload so it never recurs
            if (!cancelled) {
              setUpgradeDone(true);
              setTimeout(() => window.location.reload(), 1500);
            }
            return;
          }
        }
      } catch {
        // api is down mid-recreate — keep polling until it returns on the new version
      }
      if (!cancelled && Date.now() - startedAt < TIMEOUT_MS) {
        timer = setTimeout(() => void tick(), 3000);
      } else if (!cancelled) {
        // bounded give-up: clear the marker so a later mount doesn't poll forever.
        writeUpgradeTarget(null);
      }
    };
    // small initial delay so the detached updater has begun the recreate
    timer = setTimeout(() => void tick(), 3000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [target]);

  const view = selectBannerView(status, dismissedVersion);
  // "updating" covers this session's mutation AND a resumed (persisted) upgrade, so a
  // refresh mid-upgrade still shows the state and keeps polling until the new version.
  const updating =
    !upgradeDone &&
    (upgrade.isPending || upgrade.isSuccess || persistedTarget !== null);
  const showUpgrade =
    !updating &&
    !upgradeDone &&
    selectUpgradeAction(view, {
      selfUpdateEnabled: isCapable("selfUpdate"),
      isAdmin: isAdminSession(session),
    });
  // Render when there's an update to show OR we're mid-upgrade (even if
  // /update-status is briefly unavailable while the api recreates → view is null).
  if (!view && !updating && !upgradeDone) return null;

  const label = view ? (view.releaseName ?? view.version) : null;

  function confirmUpgrade() {
    if (!view) return;
    setConfirmOpen(false);
    // The target is the validated latest version the banner already read — never
    // free-form input (design D3); the api re-validates it against /update-status.
    upgrade.mutate({ target: view.version });
  }

  return (
    <div
      role="status"
      data-update-banner=""
      className={cn(
        "mb-3 flex items-center gap-3 rounded-md border border-border bg-muted/60 px-3 py-2 text-sm text-foreground",
        className,
      )}
    >
      <ArrowUpCircle className="size-4 shrink-0 text-primary" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        {updating || upgradeDone ? (
          <>
            正在应用更新
            {target ? (
              <>
                {" 到 "}
                <strong className="font-semibold">{target}</strong>
              </>
            ) : null}
          </>
        ) : view ? (
          <>
            新版本 <strong className="font-semibold">{label}</strong> 可用
            {view.releaseUrl ? (
              <>
                {" — "}
                <a
                  href={view.releaseUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="font-medium text-primary underline-offset-4 hover:underline"
                >
                  查看更新内容
                </a>
              </>
            ) : null}
          </>
        ) : null}
      </span>

      {upgradeDone ? (
        // The new version is live (polled /version == target); briefly confirm, then
        // window.location.reload() (scheduled in the effect) loads the new console.
        <span
          data-update-state="done"
          className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-primary"
        >
          <ArrowUpCircle className="size-3.5" aria-hidden="true" />
          已更新到 {target ?? view?.version},正在刷新…
        </span>
      ) : updating ? (
        // After a successful ack the api is recreating itself; surface the
        // "updating… reconnecting" state while we poll /version for the new build.
        <span
          data-update-state="updating"
          className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-muted-foreground"
        >
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          正在更新… 重新连接中
        </span>
      ) : showUpgrade ? (
        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <Button
            type="button"
            variant="default"
            size="sm"
            className="shrink-0"
            data-update-upgrade=""
            onClick={() => setConfirmOpen(true)}
          >
            升级到 {view?.version}
          </Button>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>确认升级到 {view?.version}？</DialogTitle>
              <DialogDescription>
                此操作以宿主机 root 权限运行容器编排。
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="text-sm text-muted-foreground">
              <p>
                升级将拉取目标版本的镜像并就地重建服务进程。能点击此按钮的人，等同于能在宿主机上以
                root 身份运行命令——请确认你信任此次升级目标（{view?.version}）。
              </p>
              <p className="mt-2">
                进行中的任务会被保留并在新进程上重新接管，操作台将通过现有连接自动重连。
              </p>
            </DialogBody>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setConfirmOpen(false)}
              >
                取消
              </Button>
              <Button
                type="button"
                variant="default"
                size="sm"
                data-update-confirm=""
                onClick={confirmUpgrade}
              >
                确认升级
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {view && !updating && !upgradeDone ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="忽略此版本提示"
          onClick={() => setDismissedVersion(view.version)}
        >
          <X aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}
