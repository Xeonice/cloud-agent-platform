/**
 * Repo content-copy state, as the console reads it (add-repo-content-store).
 *
 * A Repo now carries an OPTIONAL `copyStatus` / `copyUpdatedAt` pair describing
 * its bare-mirror copy in the repo store. Two rules make this honest here:
 *
 *   1. ABSENT ≠ missing. `copyStatus` is additive and optional: an api build
 *      that predates the content store simply does not send it. The console
 *      therefore treats an absent field as "this deployment does not report copy
 *      state" — it renders no badge and gates nothing (the api is the authority
 *      on whether a task may start, and an older api has no gate to enforce).
 *      A deployment that DOES have the store always sends a value (`missing` for
 *      rows that predate it), so nothing real is hidden by this rule.
 *   2. Only `ready` runs. When the field IS present, anything other than `ready`
 *      blocks task creation, and every remedy is the SAME action — the repo
 *      list's 刷新副本 button (`POST /repos/:repoId/refresh-copy`), which both
 *      acquires a missing copy and retries a failed one.
 *
 * PURE + SSR-safe: no window/clock/random. Timestamp formatting takes the
 * caller's locale-free deterministic path so server and client agree.
 */
import type {
  Repo,
  RepoCopyStatus,
  TaskRepoCopyBlockingStatus,
} from "@cap/contracts";
import type { StatusPillVariant } from "@/components/status-pill";

/** The subset of a Repo this module reads. */
export type RepoCopyFields = Pick<Repo, "copyStatus" | "copyUpdatedAt">;

/**
 * The reported copy state, or `null` when this deployment does not report one
 * (see rule 1 above). Never invents `missing` for an absent field.
 */
export function repoCopyStatus(repo: RepoCopyFields): RepoCopyStatus | null {
  return repo.copyStatus ?? null;
}

/** Per-status badge presentation for the repository views. */
export const REPO_COPY_STATUS_PRESENTATION: Record<
  RepoCopyStatus,
  { label: string; variant: StatusPillVariant }
> = {
  ready: { label: "副本就绪", variant: "green" },
  refreshing: { label: "副本刷新中", variant: "blue" },
  missing: { label: "副本待建立", variant: "warn" },
  failed: { label: "副本失败", variant: "danger" },
};

/**
 * Whether task creation against this repo is blocked by its copy state. False
 * for a deployment that reports nothing (rule 1) and for `ready`.
 */
export function repoCopyBlocksTaskCreate(repo: RepoCopyFields): boolean {
  const status = repoCopyStatus(repo);
  return status !== null && status !== "ready";
}

/**
 * The blocking status in the vocabulary the api's rejection uses, or `null` when
 * nothing is blocked. Lets the console reuse the shared contract wording.
 */
export function repoCopyBlockingStatus(
  repo: RepoCopyFields,
): TaskRepoCopyBlockingStatus | null {
  const status = repoCopyStatus(repo);
  if (status === null || status === "ready") return null;
  return status;
}

/**
 * Console-facing guidance for a blocked create. Deliberately NOT the contract's
 * `taskRepoCopyNotReadyMessage` (which names the REST path — right for API/MCP
 * clients, wrong for an operator looking at a button): every variant points at
 * the one console affordance that unblocks it.
 */
export function repoCopyBlockedGuidance(
  status: TaskRepoCopyBlockingStatus,
): string {
  switch (status) {
    case "missing":
      return "该仓库还没有内容副本，无法创建任务。请到「仓库范围」页对它点击「刷新副本」完成补建后重试。";
    case "refreshing":
      return "该仓库的内容副本正在刷新，完成后即可创建任务；大仓库可能需要数分钟。";
    case "failed":
      return "该仓库上一次内容副本获取失败，无法创建任务。请到「仓库范围」页点击「刷新副本」重试，或重新导入该仓库。";
    case "unknown":
      return "该仓库的内容副本状态无法识别，无法创建任务。请到「仓库范围」页点击「刷新副本」重新获取。";
  }
}

/**
 * Format the last successful copy time as a fixed `YYYY-MM-DD HH:mm` UTC-free
 * local string. Returns `null` when no copy has ever completed, so callers can
 * say「尚未建立」rather than print a fabricated time.
 */
export function formatRepoCopyUpdatedAt(
  copyUpdatedAt: Date | null | undefined,
): string | null {
  if (!copyUpdatedAt) return null;
  const time = copyUpdatedAt.getTime();
  if (Number.isNaN(time)) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${copyUpdatedAt.getFullYear()}-${pad(copyUpdatedAt.getMonth() + 1)}-` +
    `${pad(copyUpdatedAt.getDate())} ${pad(copyUpdatedAt.getHours())}:` +
    `${pad(copyUpdatedAt.getMinutes())}`
  );
}

/** The caption shown under a copy badge (last-good time, or its absence). */
export function repoCopyUpdatedCaption(repo: RepoCopyFields): string {
  const formatted = formatRepoCopyUpdatedAt(repo.copyUpdatedAt);
  return formatted ? `副本更新于 ${formatted}` : "副本尚未建立";
}
