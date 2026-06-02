#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FileEdit, PostToolUseReportFrame } from '@cap/contracts';
import { PostToolUseReportFrameSchema, FRAME_CHANNEL } from '@cap/contracts';

const execFileAsync = promisify(execFile);

/**
 * `PostToolUse` file-edit reporting with a git-diff fallback
 * (agent-events-and-approvals spec, "PostToolUse file-edit reporting with
 * git-diff fallback").
 *
 * Codex hook tool coverage is PARTIAL (design D6 / context), so a `PostToolUse`
 * event will not surface every file change. This module therefore:
 *   - emits a file-edit report from the `PostToolUse` event (post-hoc only — it
 *     NEVER gates or undoes the already-executed command), and
 *   - computes a workspace git diff as a fallback, merging in any file change
 *     that no `PostToolUse` event reported.
 *
 * Crucially this hook does not return a decision and is never used to block or
 * reverse a command: the command has already run by the time `PostToolUse`
 * fires.
 */

/** A file edit reported by a `PostToolUse` event (before tagging the source). */
export interface ReportedEdit {
  path: string;
  diff?: string;
}

/** A path plus the coarse change kind inferred from git status. */
interface GitChangedFile {
  path: string;
  change: FileEdit['change'];
}

/** Runs `git` in the workspace; injectable for testing. */
export interface GitRunner {
  /** Return the changed-file paths with their change kind in the workspace working tree. */
  changedFiles(workspaceDir: string): Promise<GitChangedFile[]>;
  /** Return a unified diff for a single path, or `undefined` if unavailable. */
  diffForPath(workspaceDir: string, path: string): Promise<string | undefined>;
}

/**
 * Default git runner backed by the `git` CLI. Uses `git status --porcelain` to
 * enumerate working-tree changes (covering edits the hook channel missed) and
 * `git diff` for per-file unified diffs.
 */
export const cliGitRunner: GitRunner = {
  async changedFiles(workspaceDir: string): Promise<GitChangedFile[]> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', workspaceDir, 'status', '--porcelain', '--untracked-files=all'],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      return parsePorcelainFiles(stdout);
    } catch {
      // No git repo / git unavailable: the fallback simply contributes nothing.
      return [];
    }
  },

  async diffForPath(workspaceDir: string, path: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', workspaceDir, 'diff', 'HEAD', '--', path],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      return stdout.length > 0 ? stdout : undefined;
    } catch {
      return undefined;
    }
  },
};

/**
 * Parse `git status --porcelain` output into changed-file records with change kinds.
 *
 * Each line is `XY <path>` (or `XY <orig> -> <path>` for renames); we take the
 * destination path and infer the change kind from the status characters:
 *   - `?` (untracked) → `created`
 *   - `D` (either column) → `deleted`
 *   - anything else   → `modified`
 */
export function parsePorcelainFiles(porcelain: string): GitChangedFile[] {
  const files: GitChangedFile[] = [];
  for (const line of porcelain.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    // Strip the two-character status field and the separating space.
    const xy = line.slice(0, 2);
    const rest = line.slice(3);
    const renameArrow = rest.indexOf(' -> ');
    const rawPath = renameArrow >= 0 ? rest.slice(renameArrow + 4) : rest;
    const path = unquotePorcelainPath(rawPath.trim());
    if (path.length === 0) {
      continue;
    }

    let change: FileEdit['change'];
    if (xy.includes('?')) {
      change = 'created';
    } else if (xy.includes('D')) {
      change = 'deleted';
    } else {
      change = 'modified';
    }

    files.push({ path, change });
  }
  return files;
}

/**
 * @deprecated Use `parsePorcelainFiles` instead. Kept for backward compatibility
 * with any callers that only need paths.
 */
export function parsePorcelainPaths(porcelain: string): string[] {
  return parsePorcelainFiles(porcelain).map((f) => f.path);
}

/** Porcelain quotes paths containing special characters in double quotes. */
function unquotePorcelainPath(path: string): string {
  if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) {
    return path.slice(1, -1);
  }
  return path;
}

/**
 * Build a file-edit report for one `PostToolUse` event, merging in a git-diff
 * fallback for any workspace change the event did not report.
 *
 * Reported edits keep `source: 'post_tool_use'`; fallback-only edits get
 * `source: 'git_diff'`. A path reported by the event is NOT duplicated by the
 * fallback. Reported edits default to `change: 'modified'` (the PostToolUse
 * hook payload does not carry a change-kind; the git fallback infers it from
 * the porcelain status).
 */
export async function buildFileEditReport(
  taskId: string,
  workspaceDir: string,
  reportedEdits: readonly ReportedEdit[],
  git: GitRunner = cliGitRunner,
): Promise<PostToolUseReportFrame> {
  const edits: FileEdit[] = reportedEdits.map((edit) =>
    edit.diff !== undefined
      ? { path: edit.path, change: 'modified' as const, diff: edit.diff, source: 'post_tool_use' as const }
      : { path: edit.path, change: 'modified' as const, source: 'post_tool_use' as const },
  );

  const reportedPaths = new Set(reportedEdits.map((edit) => edit.path));

  const changedFiles = await git.changedFiles(workspaceDir);
  for (const { path, change } of changedFiles) {
    if (reportedPaths.has(path)) {
      // Already covered by a PostToolUse event; do not double-report.
      continue;
    }
    const diff = await git.diffForPath(workspaceDir, path);
    edits.push(
      diff !== undefined
        ? { path, change, diff, source: 'git_diff' as const }
        : { path, change, source: 'git_diff' as const },
    );
  }

  // Validate the assembled report against the authoritative contracts schema.
  return PostToolUseReportFrameSchema.parse({
    channel: FRAME_CHANNEL.CONTROL,
    type: 'post_tool_use_report',
    taskId,
    edits,
  });
}

/**
 * Read the `PostToolUse` hook payload from stdin, build the merged file-edit
 * report, and print it to stdout. This hook emits a report and exits; it never
 * prints a decision and never blocks the command (post-hoc reporting only).
 */
export async function main(
  taskId: string,
  workspaceDir: string,
  git: GitRunner = cliGitRunner,
  stdin: NodeJS.ReadableStream = process.stdin,
  stdout: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  const raw = await readAll(stdin);
  const reportedEdits = extractReportedEdits(raw);
  const report = await buildFileEditReport(taskId, workspaceDir, reportedEdits, git);
  stdout.write(JSON.stringify(report));
}

/**
 * Best-effort extraction of reported edits from a `PostToolUse` payload. The
 * exact Codex payload shape varies by tool; we look for a `path`/`file_path`
 * plus an optional `diff`/`patch`. Anything we cannot read still produces a
 * report (the git-diff fallback covers it).
 */
export function extractReportedEdits(raw: string): ReportedEdit[] {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof payload !== 'object' || payload === null) {
    return [];
  }

  const record = payload as Record<string, unknown>;
  const path =
    typeof record['path'] === 'string'
      ? (record['path'] as string)
      : typeof record['file_path'] === 'string'
        ? (record['file_path'] as string)
        : undefined;
  if (path === undefined) {
    return [];
  }
  const diff =
    typeof record['diff'] === 'string'
      ? (record['diff'] as string)
      : typeof record['patch'] === 'string'
        ? (record['patch'] as string)
        : undefined;

  return diff !== undefined ? [{ path, diff }] : [{ path }];
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
