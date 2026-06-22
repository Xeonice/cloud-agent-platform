/**
 * The single shared `McpServer` factory (remote-mcp-server, Track
 * `mcp-endpoint-tools`, tasks 4.1 / 4.2).
 *
 * Builds ONE {@link McpServer} with the six tools registered ONCE (task 4.1: "one
 * `McpServer` (tools registered once), transport per request"). The controller
 * connects a fresh stateless `StreamableHTTPServerTransport` to THIS server on
 * every request, so the heavy tool wiring is done a single time at construction
 * and reused.
 *
 * It implements the {@link McpToolDeps} port by delegating to the EXISTING console
 * services injected by Nest — exactly the services `/v1` and the console use, so
 * there is no second admission path (design D1/D4):
 *   - {@link TasksService} for create/get/list/stop (the console admission path:
 *     `create` persists the row then offers it to the guardrails semaphore and
 *     returns the handle, never awaiting the run);
 *   - the durable session-history read (durable-first → container fallback →
 *     read-through backfill), byte-identical to {@link V1TranscriptController}, so
 *     the raw PTY/WebSocket stream is NEVER exposed — only archived transcript
 *     text;
 *   - {@link ReposService} for the repo read surface.
 *
 * The acting operator's GitHub id (for audit attribution on create/stop) is read
 * from the resolved token's `AuthInfo.extra.githubId` when `resolveMcpToken`
 * (Track 3) attaches it; absent ⇒ no attribution (best-effort, like a scopeless
 * legacy principal on REST).
 */
import { Inject, Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  SessionHistorySchema,
  type SessionHistory,
} from '@cap/contracts';
import { TasksService } from '../tasks/tasks.service';
import { ReposService } from '../repos/repos.service';
import {
  TRANSCRIPT_STORE,
  type TranscriptStore,
} from '../tasks/session-history.controller';
import {
  SANDBOX_PROVIDER,
  type SandboxProvider,
} from '../sandbox/sandbox-provider.port';
import { parseTranscript } from '../sandbox/parse-transcript';
import {
  transcriptFormatForRuntime,
  type RuntimeId,
  type TranscriptFormat,
} from '../agent-runtime/agent-runtime.port';
import {
  registerMcpTools,
  type McpToolDeps,
  type ToolExtra,
  type ToolRegistrar,
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
  /** Built once; reused across every per-request stateless transport. */
  private readonly server: McpServer;

  constructor(
    private readonly tasks: TasksService,
    private readonly repos: ReposService,
    @Inject(TRANSCRIPT_STORE) private readonly transcripts: TranscriptStore,
    @Inject(SANDBOX_PROVIDER) private readonly sandbox: SandboxProvider,
  ) {
    this.server = new McpServer(MCP_SERVER_INFO);
    // Register the six tools ONCE against this factory (which is the McpToolDeps
    // surface). The transport is per-request; the server + its tools are not. The
    // real `McpServer` is passed through the narrow `ToolRegistrar` port (see its
    // doc in mcp-tools.ts) — structurally compatible, sidestepping the SDK
    // `registerTool` deep-generic instantiation.
    registerMcpTools(
      this.server as unknown as ToolRegistrar,
      this,
      githubIdFromExtra,
    );
  }

  /** The shared, tools-registered server the controller connects per request. */
  getServer(): McpServer {
    return this.server;
  }

  // --- McpToolDeps — delegate to the existing console services ----------------

  /**
   * The console admission path. `TasksService.create` persists the task row then
   * offers it to the guardrails semaphore and RETURNS the handle — it does NOT
   * await the run — so `create_task` returns immediately (spec / D4).
   */
  createTask(repoId: string, body: Parameters<TasksService['create']>[1], githubId?: number) {
    // add-headless-execution-track: MCP is a programmatic consumer → fire-and-forget
    // headless-exec (the task runs `codex exec`/`claude -p`, exits to terminal).
    return this.tasks.create(repoId, body, githubId, 'headless-exec');
  }

  getTask(id: string) {
    return this.tasks.findById(id);
  }

  listTasks() {
    return this.tasks.list();
  }

  stopTask(id: string, githubId?: number) {
    return this.tasks.stop(id, githubId);
  }

  listRepos() {
    return this.repos.list();
  }

  /**
   * The durable session-history read — durable-first, container fallback,
   * read-through backfill — IDENTICAL to {@link V1TranscriptController.get} and
   * the console `GET /tasks/:id/session-history`. Never reads the live PTY/WS
   * stream; only archived transcript text. 404 (NotFoundException from
   * `findById`) bubbles to the tool as an MCP error when the task is unknown.
   */
  async getTranscript(id: string): Promise<SessionHistory> {
    const task = await this.tasks.findById(id);

    // The agent never started → no transcript ever existed (honest empty state).
    if (task.status === 'agent_failed_to_start') {
      return SessionHistorySchema.parse({
        status: 'empty',
        reason: 'agent-failed-to-start',
      });
    }

    // The task's runtime decides where its transcript lands + how it parses
    // (add-headless-execution-track).
    const runtime = task.runtime as RuntimeId | null;
    const format = transcriptFormatForRuntime(runtime);

    // (1) DURABLE-FIRST: the persisted archive outlives the container.
    const durable = await this.transcripts.readDurable(id);
    if (durable !== null) {
      return toAvailable(id, durable, task.status, format);
    }

    // (2) FALLBACK: read the rollout out of the retained sandbox (null = none). The
    // provider returns the runtime-tagged TranscriptSource (unify-transcript-parsers
    // D3); we consume its RAW `jsonl` so the durable archive stays byte-for-byte the
    // same raw text and the parse facade keeps its stable `(jsonl, format)` signature.
    const source = await this.sandbox.readRolloutFromContainer(id, runtime);
    if (source !== null) {
      // Read-through backfill so the NEXT read is a durable hit. Best-effort.
      await this.transcripts.backfill(id, source.jsonl);
      return toAvailable(id, source.jsonl, task.status, format);
    }

    // (3) Neither source yields a rollout: distinguish a reaped session
    // (`expired`) from a present-but-transcriptless sandbox (`empty`).
    const exists = await this.sandbox.sandboxExists(id);
    return SessionHistorySchema.parse(
      exists ? { status: 'empty', reason: 'no-rollout' } : { status: 'expired' },
    );
  }
}

/** Parse a raw rollout (durable or container source) into the available state. */
function toAvailable(
  id: string,
  jsonl: string,
  status: string,
  format: TranscriptFormat,
): SessionHistory {
  const { turns, meta } = parseTranscript(jsonl, format);
  return SessionHistorySchema.parse({
    status: 'available',
    turns,
    meta: { taskId: id, ...meta },
    isInterrupted: status === 'cancelled',
  });
}

/**
 * Best-effort GitHub-id attribution from the resolved token. `resolveMcpToken`
 * (Track 3) may attach the owner's numeric github id under `AuthInfo.extra`; a
 * non-numeric/absent value attributes the action to no id (like a scopeless
 * legacy principal on the REST path).
 */
function githubIdFromExtra(extra: ToolExtra): number | undefined {
  const raw = (extra.authInfo?.extra as { githubId?: unknown } | undefined)
    ?.githubId;
  return typeof raw === 'number' ? raw : undefined;
}
