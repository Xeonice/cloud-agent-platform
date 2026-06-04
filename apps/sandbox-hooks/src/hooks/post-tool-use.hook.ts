#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
 *
 * Transport (migrate-execution-to-aio-sandbox, Track derived-image-and-hooks,
 * task 5.4): under connect-in the report is re-homed onto an OUTBOUND HTTP POST
 * from the sandbox to the orchestrator approvals endpoint over `cap-net`
 * ({@link HttpReportTransport}), replacing the prior runner dial-back / WS
 * transport. Only the transport changes; the report-building logic above it is
 * unchanged.
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
 * Transport that delivers the assembled `PostToolUse` report to the orchestrator
 * (migrate-execution-to-aio-sandbox, Track derived-image-and-hooks, task 5.4).
 * The hook depends only on this minimal port so the report-building logic above
 * it is unchanged and it can be driven and tested in isolation.
 */
export interface ReportTransport {
  /** Deliver one assembled file-edit report to the orchestrator. */
  sendReport(report: PostToolUseReportFrame): Promise<void>;
}

/**
 * Outbound HTTP report transport. POSTs the assembled `PostToolUse` report to the
 * orchestrator approvals endpoint, reachable by container name over `cap-net`
 * (replacing the prior runner dial-back / WS transport). `PostToolUse` is
 * post-hoc and non-blocking, so a delivery failure is swallowed (best-effort);
 * it never blocks or reverses the already-executed command.
 */
export class HttpReportTransport implements ReportTransport {
  constructor(
    /** Absolute orchestrator approvals URL, reachable by container name on `cap-net`. */
    private readonly approvalsUrl: string,
    /** Injectable fetch (defaults to the global) so the transport is testable. */
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async sendReport(report: PostToolUseReportFrame): Promise<void> {
    try {
      await this.fetchImpl(this.approvalsUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(report),
      });
    } catch {
      // Best-effort post-hoc reporting: never throw out of a non-blocking hook.
    }
  }
}

/**
 * Read the `PostToolUse` hook payload from stdin, build the merged file-edit
 * report, and print it to stdout. This hook emits a report and exits; it never
 * prints a decision and never blocks the command (post-hoc reporting only).
 *
 * When a `transport` is supplied (the connect-in CLI bootstrap injects
 * {@link HttpReportTransport}), the report is ALSO delivered over the outbound
 * HTTP callback; the stdout write is preserved as the in-band channel and for
 * test capture.
 */
export async function main(
  taskId: string,
  workspaceDir: string,
  git: GitRunner = cliGitRunner,
  stdin: NodeJS.ReadableStream = process.stdin,
  stdout: NodeJS.WritableStream = process.stdout,
  transport?: ReportTransport,
): Promise<void> {
  const raw = await readAll(stdin);
  const reportedEdits = extractReportedEdits(raw);
  const report = await buildFileEditReport(taskId, workspaceDir, reportedEdits, git);
  if (transport !== undefined) {
    await transport.sendReport(report);
  }
  stdout.write(JSON.stringify(report));
}

/** Pick the first string-valued key from a record (path/diff extraction helper). */
function firstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

/**
 * Best-effort extraction of reported edits from a `PostToolUse` payload.
 *
 * Under codex `0.131` the file path/diff live inside the nested `tool_input`
 * object (`{tool_name, tool_input:{file_path|path, diff|patch}}`), so this reads
 * `tool_input` FIRST, then falls back to legacy top-level `path`/`file_path` +
 * `diff`/`patch` for older payload shapes. Anything we cannot read still
 * produces a report (the git-diff fallback covers it).
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
  const toolInput =
    typeof record['tool_input'] === 'object' && record['tool_input'] !== null
      ? (record['tool_input'] as Record<string, unknown>)
      : undefined;

  // codex 0.131 nests the path/diff under tool_input; fall back to legacy
  // top-level keys so older payload shapes still report.
  const path =
    (toolInput !== undefined
      ? firstString(toolInput, ['file_path', 'path'])
      : undefined) ?? firstString(record, ['path', 'file_path']);
  if (path === undefined) {
    return [];
  }
  const diff =
    (toolInput !== undefined
      ? firstString(toolInput, ['diff', 'patch'])
      : undefined) ?? firstString(record, ['diff', 'patch']);

  return diff !== undefined ? [{ path, diff }] : [{ path }];
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * CLI bootstrap (migrate-execution-to-aio-sandbox, Track derived-image-and-hooks,
 * task 5.4). This file is baked into the derived AIO image at
 * `/opt/cap/dist/hooks/post-tool-use.hook.js` and invoked by Codex as a
 * non-blocking `PostToolUse` hook (see `~/.codex/hooks.json`).
 *
 * When run directly, it reads the task identity and the orchestrator approvals
 * URL from the env injected into the sandbox container by `AioSandboxProvider`
 * (`TASK_ID`, `WORKSPACES_DIR`/`WORKSPACE_DIR`, `ORCHESTRATOR_APPROVALS_URL`),
 * wires {@link HttpReportTransport}, and delivers the report over the outbound
 * HTTP callback. With no approvals URL configured the report is still printed to
 * stdout but not delivered (best-effort, post-hoc only).
 */
export async function runCli(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const taskId = env['TASK_ID'] ?? '';
  const workspaceDir = env['WORKSPACES_DIR'] ?? env['WORKSPACE_DIR'] ?? process.cwd();
  const approvalsUrl = env['ORCHESTRATOR_APPROVALS_URL'];
  const transport =
    approvalsUrl !== undefined && approvalsUrl.length > 0
      ? new HttpReportTransport(approvalsUrl)
      : undefined;
  await main(taskId, workspaceDir, cliGitRunner, process.stdin, process.stdout, transport);
}

// Run only when executed as the entry module (the baked hook script), never on
// import (tests import the builder/transport with stubs).
// realpath both sides so a symlinked entry path still matches import.meta.url.
const entry = process.argv[1];
if (entry !== undefined) {
  let isEntry = false;
  try {
    isEntry = fileURLToPath(import.meta.url) === realpathSync(entry);
  } catch {
    isEntry = false;
  }
  if (isEntry) {
    void runCli();
  }
}
