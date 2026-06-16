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
import { useQuery } from "@tanstack/react-query";
import { ArrowUpCircle, X } from "lucide-react";

import type { UpdateStatus } from "@cap/contracts";
import { updateStatusQuery } from "@/lib/api/queries";
import { cn } from "@/utils";
import { Button } from "@/components/ui/button";

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
 */
export function UpdateBanner({ className }: UpdateBannerProps) {
  const { data: status } = useQuery(updateStatusQuery());
  const dismissedVersion = useDismissedVersion();
  const view = selectBannerView(status, dismissedVersion);
  if (!view) return null;

  const label = view.releaseName ?? view.version;

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
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="忽略此版本提示"
        onClick={() => setDismissedVersion(view.version)}
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}
