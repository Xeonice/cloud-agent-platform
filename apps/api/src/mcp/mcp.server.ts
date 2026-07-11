/**
 * The request-scoped `McpServer` factory (remote-mcp-server, Track
 * `mcp-endpoint-tools`, tasks 4.1 / 4.2).
 *
 * Builds a fresh {@link McpServer} for each stateless HTTP request. The SDK
 * protocol object owns exactly one transport and rejects a second concurrent
 * `connect`, so the server and transport share the same request lifetime.
 *
 * It implements the {@link McpToolDeps} port by delegating to the EXISTING console
 * services injected by Nest — exactly the services `/v1` and the console use, so
 * there is no second admission path (design D1/D4):
 *   - {@link TasksService} for create/get/list/stop (the console admission path:
 *     `create` persists the row then offers it to the guardrails semaphore and
 *     returns the handle, never awaiting the run);
 *   - the canonical task transcript reader shared with Console and `/v1`, including
 *     live running-task reads, durable fallback, and audit-derived system turns;
 *   - {@link ReposService} for the repo read surface and shared `/v1` page helpers.
 *   - {@link ScheduledTasksService} for owner-scoped schedule management and
 *     immediate dispatch.
 *
 * The acting operator's account id (for audit attribution on create/stop) is read
 * from the resolved token's `AuthInfo.extra.userId` when `resolveMcpToken`
 * (Track 3) attaches it; absent ⇒ no attribution (best-effort, like a scopeless
 * legacy principal on REST).
 */
import { Inject, Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionHistory } from '@cap/contracts';
import { TasksService } from '../tasks/tasks.service';
import { ReposService } from '../repos/repos.service';
import { ScheduledTasksService } from '../scheduled-tasks/scheduled-tasks.service';
import { PrismaService } from '../prisma/prisma.service';
import { listRepoPage, listTaskPage } from '../v1/public-list-pages';
import {
  AUDIT_TIMELINE_READER,
  TRANSCRIPT_STORE,
  readTaskTranscript,
  type AuditTimelineReader,
  type TranscriptStore,
} from '../tasks/task-transcript-reader';
import {
  SANDBOX_PROVIDER,
  type SandboxProvider,
} from '../sandbox/sandbox-provider.port';
import {
  registerMcpTools,
  type McpToolDeps,
  type ToolRegistrar,
  userIdFromExtra,
} from './mcp-tools';

/**
 * The MCP server identity advertised in the `initialize` handshake. The version
 * here is the MCP server protocol-surface label (cosmetic, shown to clients), not
 * the deployed app build version (that lives on `GET /version`).
 */
const MCP_SERVER_INFO = {
  name: 'cloud-agent-platform',
  version: '1.0.0',
} as const;

@Injectable()
export class McpServerFactory implements McpToolDeps {
  constructor(
    private readonly tasks: TasksService,
    private readonly repos: ReposService,
    private readonly schedules: ScheduledTasksService,
    private readonly prisma: PrismaService,
    @Inject(TRANSCRIPT_STORE) private readonly transcripts: TranscriptStore,
    @Inject(AUDIT_TIMELINE_READER) private readonly audit: AuditTimelineReader,
    @Inject(SANDBOX_PROVIDER) private readonly sandbox: SandboxProvider,
  ) {}

  /** Create one tools-registered SDK server for one stateless HTTP request. */
  createServer(): McpServer {
    const server = new McpServer(MCP_SERVER_INFO);
    registerMcpTools(
      server as unknown as ToolRegistrar,
      this,
      userIdFromExtra,
    );
    return server;
  }

  // --- McpToolDeps — delegate to the existing console services ----------------

  /**
   * The console admission path. `TasksService.create` persists the task row then
   * offers it to the guardrails semaphore and RETURNS the handle — it does NOT
   * await the run — so `create_task` returns immediately (spec / D4).
   */
  createTask(repoId: string, body: Parameters<TasksService['create']>[1], userId?: string) {
    // add-headless-execution-track: MCP is a programmatic consumer → fire-and-forget
    // headless-exec (the task runs `codex exec`/`claude -p`, exits to terminal).
    // `userId` is the token owner's ACCOUNT primary key (local + GitHub accounts —
    // fix-local-account-task-attribution) so the task is owner-attributed.
    return this.tasks.create(repoId, body, userId, 'headless-exec');
  }

  getTask(id: string) {
    return this.tasks.findById(id);
  }

  listTasks(query: Parameters<McpToolDeps['listTasks']>[0]) {
    return listTaskPage(this.prisma, query);
  }

  stopTask(id: string, userId?: string) {
    return this.tasks.stop(id, userId);
  }

  listRepos(query: Parameters<McpToolDeps['listRepos']>[0]) {
    return listRepoPage(this.prisma, query);
  }

  getRepo(id: string) {
    return this.repos.findById(id);
  }

  createSchedule(
    ownerUserId: string,
    body: Parameters<ScheduledTasksService['create']>[1],
  ) {
    return this.schedules.create(ownerUserId, body);
  }

  listSchedules(
    ownerUserId: string,
    query: Parameters<McpToolDeps['listSchedules']>[1],
  ) {
    return this.schedules.listPage(ownerUserId, query);
  }

  getSchedule(ownerUserId: string, id: string) {
    return this.schedules.get(ownerUserId, id);
  }

  updateSchedule(
    ownerUserId: string,
    id: string,
    body: Parameters<ScheduledTasksService['update']>[2],
  ) {
    return this.schedules.update(ownerUserId, id, body);
  }

  pauseSchedule(ownerUserId: string, id: string) {
    return this.schedules.pause(ownerUserId, id);
  }

  resumeSchedule(ownerUserId: string, id: string) {
    return this.schedules.resume(ownerUserId, id);
  }

  dispatchSchedule(
    ownerUserId: string,
    id: string,
    body: Parameters<McpToolDeps['dispatchSchedule']>[2],
  ) {
    return this.schedules.dispatchNow(ownerUserId, id, body);
  }

  deleteSchedule(ownerUserId: string, id: string) {
    return this.schedules.delete(ownerUserId, id);
  }

  listScheduleRuns(
    ownerUserId: string,
    id: string,
    query: Parameters<McpToolDeps['listScheduleRuns']>[2],
  ) {
    return this.schedules.listRunsPage(ownerUserId, id, query);
  }

  /** Canonical Console/`/v1`/MCP transcript read, including live and audit turns. */
  getTranscript(id: string): Promise<SessionHistory> {
    return readTaskTranscript(
      {
        tasks: this.tasks,
        sandbox: this.sandbox,
        transcripts: this.transcripts,
        audit: this.audit,
      },
      id,
    );
  }
}
