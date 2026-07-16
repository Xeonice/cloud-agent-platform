/**
 * Synchronous click fence for one Console repository-refresh mutation.
 * React pending state is intentionally not the fence: two clicks can occur
 * before the next render disables the control.
 */
export interface RepoRefreshSubmissionFence {
  current: string | null;
}

export function claimRepoRefreshSubmission(
  fence: RepoRefreshSubmissionFence,
  repoId: string,
): boolean {
  if (fence.current !== null) return false;
  fence.current = repoId;
  return true;
}

export function releaseRepoRefreshSubmission(
  fence: RepoRefreshSubmissionFence,
  repoId: string,
): void {
  if (fence.current === repoId) fence.current = null;
}
