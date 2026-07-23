import { createServer } from 'node:http';
import {
  ForgeKindSchema,
  GitBranchNameSchema,
  createRepoBodySchema,
} from '@cap/contracts';

const CONTROL_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 16 * 1024;
const MAX_RUNS = 50;
const MAX_AUDIT_EVENTS = 100;

export async function startScheduledTasksControlServer({
  prisma,
  provider,
  scheduledTasks,
  port,
}) {
  const server = createServer((request, response) => {
    void routeControlRequest({
      request,
      response,
      prisma,
      provider,
      scheduledTasks,
    });
  });

  await listen(server, port, CONTROL_HOST);
  const address = server.address();
  if (!address || typeof address === 'string') {
    await close(server);
    throw new Error('scheduled-task E2E control server did not expose a TCP address');
  }

  return {
    port: address.port,
    close: () => close(server),
  };
}

async function routeControlRequest({
  request,
  response,
  prisma,
  provider,
  scheduledTasks,
}) {
  try {
    if (!isLoopback(request.socket.remoteAddress)) {
      sendJson(response, 403, { error: 'loopback_only' });
      return;
    }

    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && requestUrl.pathname === '/control/health') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/control/scheduler/tick') {
      const body = await readJsonBody(request);
      const now = parseTickAt(body.now);
      const fired = await scheduledTasks.tick(now);
      sendJson(response, 200, { now: now.toISOString(), fired });
      return;
    }

    if (
      request.method === 'POST' &&
      requestUrl.pathname === '/control/fixtures/repos'
    ) {
      // Repository import is not part of this scheduled-task story. Seed a
      // validated test fixture directly in the disposable database through the
      // loopback-only test control plane, so the production `/repos` boundary
      // keeps requiring the authenticated owner's exact-host forge credential.
      const fixture = parseRepoFixture(await readJsonBody(request));
      const repo = await prisma.repo.create({
        // The scheduled-task story is not about repo import: seed the content
        // copy as ready so task creation passes the copy-readiness gate.
        data: { ...fixture, copyStatus: 'ready', copyUpdatedAt: new Date() },
      });
      sendJson(response, 201, { repo: sanitizeRepo(repo) });
      return;
    }

    const dueMatch = /^\/control\/schedules\/([^/]+)\/due$/.exec(
      requestUrl.pathname,
    );
    if (request.method === 'POST' && dueMatch) {
      const scheduleId = decodePathSegment(dueMatch[1]);
      const body = await readJsonBody(request);
      const dueAt = parseDueAt(body.dueAt);
      const existing = await prisma.taskSchedule.findUnique({
        where: { id: scheduleId },
        select: scheduleSelect,
      });
      if (!existing) {
        sendJson(response, 404, { error: 'schedule_not_found' });
        return;
      }
      const schedule = await prisma.taskSchedule.update({
        where: { id: scheduleId },
        data: { nextRunAt: dueAt },
        select: scheduleSelect,
      });
      sendJson(response, 200, {
        schedule: sanitizeSchedule(schedule),
      });
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/control/provider-calls') {
      const taskId = optionalQuery(requestUrl, 'taskId');
      sendJson(response, 200, {
        providerCalls: provider.evidence({ taskId }),
      });
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/control/diagnostics') {
      const diagnostics = await readDiagnostics(
        prisma,
        optionalQuery(requestUrl, 'scheduleId'),
      );
      sendJson(response, 200, { diagnostics });
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/control/evidence') {
      const taskId = optionalQuery(requestUrl, 'taskId');
      const diagnostics = await readDiagnostics(
        prisma,
        optionalQuery(requestUrl, 'scheduleId'),
      );
      const taskIds = taskId
        ? undefined
        : diagnostics.tasks.map((task) => task.id);
      sendJson(response, 200, {
        providerCalls: provider.evidence({ taskId, taskIds }),
        diagnostics,
      });
      return;
    }

    sendJson(response, 404, { error: 'not_found' });
  } catch (error) {
    const status = error instanceof ControlInputError ? error.status : 500;
    sendJson(response, status, {
      error: status === 500 ? 'control_request_failed' : error.code,
    });
  }
}

async function readDiagnostics(prisma, requestedScheduleId) {
  const schedule = requestedScheduleId
    ? await prisma.taskSchedule.findUnique({
        where: { id: requestedScheduleId },
        select: scheduleSelect,
      })
    : await prisma.taskSchedule.findFirst({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: scheduleSelect,
      });

  if (!schedule) {
    return emptyDiagnostics();
  }

  const runs = await prisma.taskScheduleRun.findMany({
    where: { scheduleId: schedule.id },
    orderBy: [{ scheduledFor: 'desc' }, { id: 'desc' }],
    take: MAX_RUNS,
    select: {
      id: true,
      scheduleId: true,
      scheduledFor: true,
      periodKey: true,
      triggerSource: true,
      triggeredAt: true,
      status: true,
      taskId: true,
      error: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const taskIds = runs.flatMap((run) => (run.taskId ? [run.taskId] : []));
  const tasks = taskIds.length === 0
    ? []
    : await prisma.task.findMany({
        where: { id: { in: taskIds } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_RUNS,
        select: {
          id: true,
          repoId: true,
          ownerUserId: true,
          status: true,
          runtime: true,
          executionMode: true,
          createdAt: true,
          scheduleRun: {
            select: { scheduleId: true, scheduledFor: true },
          },
        },
      });
  const audit = taskIds.length === 0
    ? []
    : await prisma.auditEvent.findMany({
        where: { taskId: { in: taskIds } },
        orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
        take: MAX_AUDIT_EVENTS,
        select: {
          id: true,
          taskId: true,
          userId: true,
          type: true,
          level: true,
          timestamp: true,
          resultCode: true,
          runId: true,
        },
      });

  return {
    schedule: sanitizeSchedule(schedule),
    runs: runs.map((run) => ({
      id: run.id,
      scheduleId: run.scheduleId,
      scheduledFor: iso(run.scheduledFor),
      periodKey: run.periodKey,
      triggerSource: run.triggerSource,
      triggeredAt: iso(run.triggeredAt),
      status: run.status,
      taskId: run.taskId,
      hasError: run.error !== null,
      createdAt: iso(run.createdAt),
      updatedAt: iso(run.updatedAt),
    })),
    tasks: tasks.map((task) => ({
      id: task.id,
      repoId: task.repoId,
      ownerUserId: task.ownerUserId,
      status: task.status,
      runtime: task.runtime,
      executionMode: task.executionMode,
      createdAt: iso(task.createdAt),
      scheduleProvenance: task.scheduleRun
        ? {
            scheduleId: task.scheduleRun.scheduleId,
            scheduledFor: iso(task.scheduleRun.scheduledFor),
          }
        : null,
    })),
    audit: audit.map((event) => ({
      id: event.id,
      taskId: event.taskId,
      userId: event.userId,
      type: event.type,
      level: event.level,
      timestamp: iso(event.timestamp),
      resultCode: event.resultCode,
      runId: event.runId,
    })),
    limits: { runs: MAX_RUNS, tasks: MAX_RUNS, audit: MAX_AUDIT_EVENTS },
  };
}

const scheduleSelect = {
  id: true,
  ownerUserId: true,
  repoId: true,
  enabled: true,
  nextRunAt: true,
  overlapPolicy: true,
  misfirePolicy: true,
  claimToken: true,
  claimUntil: true,
  createdAt: true,
  updatedAt: true,
};

function sanitizeSchedule(schedule) {
  return {
    id: schedule.id,
    ownerUserId: schedule.ownerUserId,
    repoId: schedule.repoId,
    enabled: schedule.enabled,
    nextRunAt: iso(schedule.nextRunAt),
    overlapPolicy: schedule.overlapPolicy,
    misfirePolicy: schedule.misfirePolicy,
    claimed: schedule.claimToken !== null,
    claimUntil: iso(schedule.claimUntil),
    createdAt: iso(schedule.createdAt),
    updatedAt: iso(schedule.updatedAt),
  };
}

function emptyDiagnostics() {
  return {
    schedule: null,
    runs: [],
    tasks: [],
    audit: [],
    limits: { runs: MAX_RUNS, tasks: MAX_RUNS, audit: MAX_AUDIT_EVENTS },
  };
}

function parseRepoFixture(body) {
  const createBody = createRepoBodySchema.safeParse({
    name: body.name,
    gitSource: body.gitSource,
    forge: body.forge,
  });
  const name = createBody.success ? createBody.data.name.trim() : '';
  const forge = ForgeKindSchema.safeParse(body.forge);
  const defaultBranch = GitBranchNameSchema.safeParse(body.defaultBranch);
  if (
    !createBody.success ||
    name.length === 0 ||
    !forge.success ||
    !defaultBranch.success
  ) {
    throw new ControlInputError(400, 'invalid_repo_fixture');
  }

  let gitSource;
  try {
    gitSource = new URL(createBody.data.gitSource);
  } catch {
    throw new ControlInputError(400, 'invalid_repo_fixture');
  }
  if (
    !['http:', 'https:'].includes(gitSource.protocol) ||
    gitSource.username.length > 0 ||
    gitSource.password.length > 0 ||
    gitSource.pathname.replace(/\/+$/, '').length === 0
  ) {
    throw new ControlInputError(400, 'invalid_repo_fixture');
  }
  gitSource.search = '';
  gitSource.hash = '';
  gitSource.pathname = gitSource.pathname.replace(/\/+$/, '');

  return {
    name,
    gitSource: gitSource.toString(),
    forge: forge.data,
    defaultBranch: defaultBranch.data,
  };
}

function sanitizeRepo(repo) {
  return {
    id: repo.id,
    name: repo.name,
    gitSource: repo.gitSource,
    forge: repo.forge,
    defaultBranch: repo.defaultBranch,
  };
}

function parseDueAt(value) {
  if (value === undefined) {
    return new Date(Date.now() - 1_000);
  }
  if (typeof value !== 'string') {
    throw new ControlInputError(400, 'invalid_due_at');
  }
  const dueAt = new Date(value);
  if (!Number.isFinite(dueAt.getTime()) || dueAt.getTime() > Date.now()) {
    throw new ControlInputError(400, 'invalid_due_at');
  }
  return dueAt;
}

function parseTickAt(value) {
  if (typeof value !== 'string') {
    throw new ControlInputError(400, 'invalid_tick_at');
  }
  const now = new Date(value);
  if (!Number.isFinite(now.getTime()) || now.toISOString() !== value) {
    throw new ControlInputError(400, 'invalid_tick_at');
  }
  return now;
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      throw new ControlInputError(413, 'body_too_large');
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body is not an object');
    }
    return parsed;
  } catch {
    throw new ControlInputError(400, 'invalid_json');
  }
}

function optionalQuery(url, name) {
  const value = url.searchParams.get(name)?.trim();
  return value ? value : undefined;
}

function decodePathSegment(value) {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded.includes('/')) throw new Error('invalid segment');
    return decoded;
  } catch {
    throw new ControlInputError(400, 'invalid_schedule_id');
  }
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : null;
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function sendJson(response, status, body) {
  if (response.headersSent) return;
  const json = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(json);
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

class ControlInputError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
