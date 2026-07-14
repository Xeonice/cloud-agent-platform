import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const TARGET_MIGRATION = '20260714120000_add_task_model_selection';
const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePrismaDir = path.join(apiDir, 'prisma');
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (process.env.CAP_TASK_MODEL_MIGRATION_TEST !== '1') {
  throw new Error(
    'Refusing destructive migration test without CAP_TASK_MODEL_MIGRATION_TEST=1',
  );
}
const parsedUrl = new URL(databaseUrl);
if (!['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname)) {
  throw new Error('Migration test DATABASE_URL must target a loopback host');
}

const tempRoot = mkdtempSync(path.join(tmpdir(), 'cap-task-model-migration-'));
const oldPrismaDir = path.join(tempRoot, 'prisma');
const oldMigrationsDir = path.join(oldPrismaDir, 'migrations');

function migrate(schemaPath) {
  const result = spawnSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy', '--schema', schemaPath],
    {
      cwd: apiDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `prisma migrate deploy failed:\n${result.stdout}\n${result.stderr}`,
    );
  }
}

async function resetPublicSchema() {
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    await client.$executeRawUnsafe('DROP SCHEMA IF EXISTS "public" CASCADE');
    await client.$executeRawUnsafe('CREATE SCHEMA "public"');
  } finally {
    await client.$disconnect();
  }
}

async function seedHistoricalRows() {
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    await client.$executeRawUnsafe(`
      INSERT INTO "users" ("id", "name", "allowed")
      VALUES ('migration-user', 'Migration User', true)
    `);
    await client.$executeRawUnsafe(`
      INSERT INTO "repos" ("id", "name", "git_source")
      VALUES ('migration-repo', 'Migration Repo', 'https://example.invalid/repo.git')
    `);
    await client.$executeRawUnsafe(`
      INSERT INTO "tasks" ("id", "repo_id", "owner_user_id", "prompt")
      VALUES ('historical-task', 'migration-repo', 'migration-user', 'historical')
    `);
    await client.$executeRawUnsafe(`
      INSERT INTO "task_schedules" (
        "id", "owner_user_id", "repo_id", "task_template", "cron", "timezone"
      ) VALUES (
        'migration-schedule',
        'migration-user',
        'migration-repo',
        '{"repoId":"migration-repo","prompt":"historical"}'::jsonb,
        '0 9 * * *',
        'UTC'
      )
    `);
    await client.$executeRawUnsafe(`
      INSERT INTO "task_schedule_runs" (
        "id", "schedule_id", "scheduled_for", "status"
      ) VALUES (
        'historical-run',
        'migration-schedule',
        '2026-07-14T00:00:00.000Z',
        'failed'
      )
    `);
  } finally {
    await client.$disconnect();
  }
}

async function expectConstraintFailure(operation, label) {
  await assert.rejects(operation, undefined, label);
}

async function verifyCurrentSchema() {
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const historicalTask = await client.task.findUniqueOrThrow({
      where: { id: 'historical-task' },
    });
    assert.equal(historicalTask.model, null);
    assert.equal(historicalTask.executionEnvironmentSnapshot, null);

    const historicalRun = await client.taskScheduleRun.findUniqueOrThrow({
      where: { id: 'historical-run' },
    });
    assert.equal(historicalRun.errorCode, null);
    assert.equal(historicalRun.retryAt, null);
    assert.equal(historicalRun.retryAttempt, null);
    assert.equal(historicalRun.retryHorizonAt, null);
    assert.equal(historicalRun.retryTaskTemplate, null);

    const snapshot = {
      schemaVersion: 1,
      kind: 'deployment-default',
      managedEnvironmentId: null,
      validationId: null,
      validationContractVersion: null,
      provider: 'aio',
      providerFamily: 'aio',
      source: {
        kind: 'aio-docker-image',
        locator: 'ghcr.io/cap/aio@sha256:test-image',
        digest: 'sha256:test-image',
        checksum: null,
      },
      immutableIdentity: 'sha256:test-image',
      fingerprint: 'sha256:test-environment',
      sandboxMetadata: {
        schemaVersion: 1,
        sandboxVersion: '1.2.3',
        dependencies: { codex: '0.144.1' },
      },
      sandboxMetadataChecksum: `sha256:${'a'.repeat(64)}`,
      cliVersion: '0.144.1',
      cliArtifactChecksum: `sha256:${'b'.repeat(64)}`,
      resolvedAt: '2026-07-14T00:00:00.000Z',
    };
    const explicit = await client.task.create({
      data: {
        id: 'explicit-model-task',
        repoId: 'migration-repo',
        ownerUserId: 'migration-user',
        prompt: 'explicit',
        model: 'provider/model:v1',
        executionEnvironmentSnapshot: snapshot,
      },
    });
    assert.equal(explicit.model, 'provider/model:v1');
    assert.deepEqual(explicit.executionEnvironmentSnapshot, snapshot);

    const retrying = await client.taskScheduleRun.create({
      data: {
        id: 'retrying-run',
        scheduleId: 'migration-schedule',
        scheduledFor: new Date('2026-07-15T00:00:00.000Z'),
        periodKey: 'automatic:2026-07-15',
        triggerSource: 'automatic',
        status: 'retrying',
        error: 'Model catalog is temporarily unavailable.',
        errorCode: 'runtime_model_catalog_unavailable',
        retryAt: new Date('2026-07-15T00:00:05.000Z'),
        retryAttempt: 1,
        retryHorizonAt: new Date('2026-07-15T00:05:00.000Z'),
        retryTaskTemplate: {
          repoId: 'migration-repo',
          prompt: 'historical',
          model: 'provider/model:v1',
        },
      },
    });
    assert.equal(retrying.status, 'retrying');
    assert.equal(retrying.retryAttempt, 1);

    await expectConstraintFailure(
      client.$executeRawUnsafe(`
        INSERT INTO "tasks" ("id", "repo_id", "prompt", "model")
        VALUES ('invalid-model-task', 'migration-repo', 'invalid', 'model-without-snapshot')
      `),
      'explicit model without snapshot must fail',
    );
    await expectConstraintFailure(
      client.$executeRawUnsafe(`
        INSERT INTO "task_schedule_runs" (
          "id", "schedule_id", "scheduled_for", "status"
        ) VALUES (
          'invalid-retrying-run',
          'migration-schedule',
          '2026-07-16T00:00:00.000Z',
          'retrying'
        )
      `),
      'retrying run without durable metadata must fail',
    );
  } finally {
    await client.$disconnect();
  }
}

try {
  await resetPublicSchema();
  mkdirSync(oldMigrationsDir, { recursive: true });
  cpSync(
    path.join(sourcePrismaDir, 'schema.prisma'),
    path.join(oldPrismaDir, 'schema.prisma'),
  );
  cpSync(
    path.join(sourcePrismaDir, 'migrations', 'migration_lock.toml'),
    path.join(oldMigrationsDir, 'migration_lock.toml'),
  );
  for (const name of readdirSync(path.join(sourcePrismaDir, 'migrations'))) {
    if (name < TARGET_MIGRATION && name !== 'migration_lock.toml') {
      cpSync(
        path.join(sourcePrismaDir, 'migrations', name),
        path.join(oldMigrationsDir, name),
        { recursive: true },
      );
    }
  }

  migrate(path.join(oldPrismaDir, 'schema.prisma'));
  await seedHistoricalRows();
  migrate(path.join(sourcePrismaDir, 'schema.prisma'));
  await verifyCurrentSchema();
  console.log(
    'task-model migration: historical null reads, explicit snapshot, retry ledger, and constraints passed',
  );
} finally {
  await resetPublicSchema();
  rmSync(tempRoot, { recursive: true, force: true });
}
