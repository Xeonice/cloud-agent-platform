import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, resolve, basename } from 'node:path';
import { GitBranchNameSchema, LOCAL_REPO_IMPORT_ROOT_ENV } from '@cap/contracts';

/**
 * Local-path import gate (local-repo-import).
 *
 * Three locks, in order, BEFORE any content is read:
 *  1. `CAP_LOCAL_IMPORT_ROOT` must be configured — unset/empty disables the
 *     feature end to end (fail-closed).
 *  2. The requested path must resolve (realpath, symlinks followed) INSIDE that
 *     root. `..` traversal and symlink escapes are rejected, and the rejection
 *     never echoes anything about the filesystem outside the root.
 *  3. The target must be a git repository (a working tree carrying `.git`, or a
 *     bare repository). This narrows "read an arbitrary path" to "read one git
 *     repository".
 *
 * Everything here is pure filesystem inspection: no git subprocess, no content
 * copy. Acquisition (the `git clone --mirror`) is the repo-store's job and only
 * runs after all three locks pass.
 */

/** Why a local import request was refused. Mapped to typed HTTP errors above. */
export type LocalImportRejection =
  /** `CAP_LOCAL_IMPORT_ROOT` is not configured. */
  | 'disabled'
  /** Configured, but the root itself is unusable inside the api container. */
  | 'root_unavailable'
  /** The requested path is structurally unusable (empty, NUL bytes, ...). */
  | 'path_invalid'
  /** Resolved outside the allowlist root (via `..`, an absolute path, or a symlink). */
  | 'outside_root'
  /** Inside the root, but nothing is there. */
  | 'not_found'
  /** Inside the root and present, but not a git repository. */
  | 'not_a_git_repository';

export type LocalImportKind = 'worktree' | 'bare';

export interface LocalImportTarget {
  /** Fully resolved absolute path; recorded as the Repo's `gitSource`. */
  readonly path: string;
  readonly kind: LocalImportKind;
  /** Display name derived from the resolved directory. */
  readonly name: string;
  /** Source `HEAD` branch, or null when it is detached/unreadable. */
  readonly defaultBranch: string | null;
}

export type LocalImportResolution =
  | { readonly ok: true; readonly target: LocalImportTarget }
  | { readonly ok: false; readonly rejection: LocalImportRejection };

/**
 * The configured allowlist root, or null when the feature is off.
 *
 * An EMPTY value is indistinguishable from unset (compose passes an empty string
 * when the operator leaves the variable blank), and a relative root is refused:
 * a root that is not absolute cannot anchor containment checks.
 */
export function readLocalImportRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const configured = env[LOCAL_REPO_IMPORT_ROOT_ENV]?.trim();
  if (!configured || configured.length === 0) return null;
  if (!isAbsolute(configured)) return null;
  // Drop a trailing separator so the root is one canonical string everywhere it
  // is compared, joined, or shown to an operator (`/srv/git/` === `/srv/git`).
  const normalized = normalize(configured).replace(/\/+$/u, '');
  return normalized.length > 0 ? normalized : '/';
}

/** True when `candidate` is `root` itself or lives beneath it. */
export function isContainedIn(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Resolves and validates a requested local import path.
 *
 * The path may be absolute or relative to the root. Containment is checked
 * TWICE: lexically (so a `..` escape is refused before touching the filesystem)
 * and again after `realpath` (so a symlink pointing out of the root is refused
 * before anything under the escape target is read).
 */
export async function resolveLocalImportTarget(
  requestedPath: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<LocalImportResolution> {
  const root = readLocalImportRoot(env);
  if (root === null) return { ok: false, rejection: 'disabled' };

  const requested = requestedPath.trim();
  if (requested.length === 0 || /\p{Cc}/u.test(requested)) {
    return { ok: false, rejection: 'path_invalid' };
  }

  const lexical = isAbsolute(requested)
    ? normalize(requested)
    : normalize(join(root, requested));
  if (!isContainedIn(root, lexical)) {
    return { ok: false, rejection: 'outside_root' };
  }

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    // The operator configured a root the api process cannot see (a missing bind
    // mount is the common case). Fail closed rather than importing anything.
    return { ok: false, rejection: 'root_unavailable' };
  }

  let resolved: string;
  try {
    resolved = await realpath(lexical);
  } catch {
    // ENOENT/EACCES/ELOOP all collapse to one answer. The lexical containment
    // check already passed, so this discloses nothing outside the root.
    return { ok: false, rejection: 'not_found' };
  }
  if (!isContainedIn(realRoot, resolved)) {
    // Symlink escape: refuse WITHOUT reading anything at the escape target.
    return { ok: false, rejection: 'outside_root' };
  }

  let isDirectory: boolean;
  try {
    isDirectory = (await stat(resolved)).isDirectory();
  } catch {
    return { ok: false, rejection: 'not_found' };
  }
  if (!isDirectory) {
    return { ok: false, rejection: 'not_a_git_repository' };
  }

  const kind = await detectGitRepository(resolved);
  if (kind === null) {
    return { ok: false, rejection: 'not_a_git_repository' };
  }

  return {
    ok: true,
    target: {
      path: resolved,
      kind,
      name: deriveLocalRepoName(resolved),
      defaultBranch: await readLocalDefaultBranch(resolved, kind),
    },
  };
}

/**
 * Classifies a directory as a git working tree (`.git` present) or a bare
 * repository (`HEAD` + `objects/` + `refs/`), or null when it is neither.
 */
export async function detectGitRepository(
  dir: string,
): Promise<LocalImportKind | null> {
  if (await pathExists(join(dir, '.git'))) return 'worktree';
  const bare =
    (await pathExists(join(dir, 'HEAD'))) &&
    (await pathExists(join(dir, 'objects'))) &&
    (await pathExists(join(dir, 'refs')));
  return bare ? 'bare' : null;
}

/** Display name for a locally imported repo: the resolved directory name. */
export function deriveLocalRepoName(resolvedPath: string): string {
  const base = basename(resolvedPath).replace(/\.git$/iu, '');
  return base.length > 0 ? base : resolvedPath;
}

/**
 * Reads the source repository's checked-out branch from `HEAD`.
 *
 * Returns null for a detached HEAD, an unreadable HEAD, or a value that is not a
 * valid branch name — a repo read path must never fabricate a branch.
 */
export async function readLocalDefaultBranch(
  resolvedPath: string,
  kind: LocalImportKind,
): Promise<string | null> {
  const gitDir = kind === 'bare' ? resolvedPath : await resolveWorktreeGitDir(resolvedPath);
  if (gitDir === null) return null;
  let head: string;
  try {
    head = await readFile(join(gitDir, 'HEAD'), 'utf8');
  } catch {
    return null;
  }
  const match = /^ref:\s*refs\/heads\/(.+)$/mu.exec(head.trim());
  if (!match) return null;
  const branch = GitBranchNameSchema.safeParse(match[1].trim());
  return branch.success ? branch.data : null;
}

/** `.git` is normally a directory, but a linked worktree stores a `gitdir:` file. */
async function resolveWorktreeGitDir(worktree: string): Promise<string | null> {
  const dotGit = join(worktree, '.git');
  try {
    if ((await stat(dotGit)).isDirectory()) return dotGit;
  } catch {
    return null;
  }
  let pointer: string;
  try {
    pointer = await readFile(dotGit, 'utf8');
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+)$/mu.exec(pointer.trim());
  if (!match) return null;
  const target = match[1].trim();
  return isAbsolute(target) ? normalize(target) : resolve(worktree, target);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
