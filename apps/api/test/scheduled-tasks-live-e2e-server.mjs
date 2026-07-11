import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import { Logger } from 'nestjs-pino';

import { AppModule } from '../dist/app.module.js';
import { PrismaService } from '../dist/prisma/prisma.service.js';
import { SANDBOX_PROVIDER } from '../dist/sandbox/sandbox-provider.port.js';
import { startScheduledTasksControlServer } from './scheduled-tasks-live-e2e/control-server.mjs';
import { RecordingSandboxProvider } from './scheduled-tasks-live-e2e/recording-sandbox-provider.mjs';

const API_HOST = '127.0.0.1';

const databaseUrl = requiredEnv('DATABASE_URL');
const webOrigin = parseLoopbackOrigin(requiredEnv('E2E_WEB_ORIGIN'));
const apiPort = portFromEnv('E2E_API_PORT');
const controlPort = portFromEnv('E2E_CONTROL_PORT');

// Make the required database contract explicit before Nest constructs Prisma.
process.env.DATABASE_URL = databaseUrl;

const provider = new RecordingSandboxProvider();
let app;
let control;
let shuttingDown = false;

try {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SANDBOX_PROVIDER)
    .useValue(provider)
    .compile();

  app = moduleRef.createNestApplication();
  app.useLogger(app.get(Logger));
  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableCors({
    origin: webOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'Last-Event-ID',
    ],
  });

  await app.listen(apiPort, API_HOST);
  const boundApiPort = tcpPort(app.getHttpServer().address(), 'API');
  const prisma = app.get(PrismaService);
  control = await startScheduledTasksControlServer({
    prisma,
    provider,
    port: controlPort,
  });

  process.stdout.write(
    `CAP_SCHEDULE_E2E_READY ${JSON.stringify({
      apiHost: API_HOST,
      apiPort: boundApiPort,
      controlHost: API_HOST,
      controlPort: control.port,
    })}\n`,
  );
} catch (error) {
  await closeResources();
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`CAP_SCHEDULE_E2E_FATAL ${message}\n`);
  process.exitCode = 1;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void closeResources().finally(() => {
      process.exitCode = 0;
    });
  });
}

async function closeResources() {
  if (shuttingDown) return;
  shuttingDown = true;
  await control?.close().catch(() => undefined);
  await app?.close().catch(() => undefined);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function portFromEnv(name) {
  const raw = process.env[name]?.trim();
  if (!raw) return 0;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`${name} must be an integer between 0 and 65535`);
  }
  return port;
}

function parseLoopbackOrigin(raw) {
  let origin;
  try {
    const url = new URL(raw);
    if (url.origin !== raw || !['http:', 'https:'].includes(url.protocol)) {
      throw new Error('origin must not contain a path');
    }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new Error('origin must be loopback');
    }
    origin = url.origin;
  } catch {
    throw new Error('E2E_WEB_ORIGIN must be an http(s) loopback origin');
  }
  return origin;
}

function tcpPort(address, label) {
  if (!address || typeof address === 'string') {
    throw new Error(`${label} server did not expose a TCP address`);
  }
  return address.port;
}
