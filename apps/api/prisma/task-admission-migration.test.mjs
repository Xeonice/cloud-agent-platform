import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  readFileSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const RESOURCE_MIGRATION =
  '20260715100000_add_sandbox_environment_resources';
const ADMISSION_MIGRATION = '20260715110000_add_task_admission_work';
const VALIDATION_RESOURCE_MIGRATION =
  '20260715120000_add_sandbox_environment_validation_resource_snapshot';
const ADMISSION_DEADLINE_MIGRATION =
  '20260715130000_add_task_admission_workspace_deadline_snapshot';
const SANDBOX_RUN_GENERATION_MIGRATION =
  '20260715140000_add_sandbox_run_generation_fence';
const LEGACY_AIO_IDENTITY_MIGRATION =
  '20260716120000_normalize_legacy_aio_sandbox_identity';
const PLATFORM_DEPENDENCY_FAILURE_MIGRATION =
  '20260716130000_add_platform_dependency_failure_codes';
const PROVISIONING_DIAGNOSTICS_MIGRATION =
  '20260717120000_add_task_provisioning_diagnostics';
const PLATFORM_DEPENDENCY_FAILURE_CODE =
  'provisioning_platform_dependency_unavailable';
const EXPECTED_WORK_COLUMNS = [
  ['task_id', 'text', 'NO'],
  ['state', 'text', 'NO'],
  ['attempt', 'integer', 'NO'],
  ['available_at', 'timestamp without time zone', 'NO'],
  ['lease_owner', 'text', 'YES'],
  ['lease_until', 'timestamp without time zone', 'YES'],
  ['stage', 'text', 'NO'],
  ['cause_code', 'text', 'YES'],
  ['resolved_branch', 'text', 'YES'],
  ['resource_snapshot', 'jsonb', 'YES'],
  ['created_at', 'timestamp without time zone', 'NO'],
  ['updated_at', 'timestamp without time zone', 'NO'],
  [
    'workspace_materialization_deadline_ms',
    'integer',
    'YES',
  ],
];
const EXPECTED_WORK_CONSTRAINTS = [
  ['task_admission_work_attempt_check', 'c'],
  ['task_admission_work_cause_code_check', 'c'],
  ['task_admission_work_cause_shape_check', 'c'],
  ['task_admission_work_lease_owner_check', 'c'],
  ['task_admission_work_lease_shape_check', 'c'],
  ['task_admission_work_pkey', 'p'],
  ['task_admission_work_resolved_branch_check', 'c'],
  ['task_admission_work_resource_snapshot_check', 'c'],
  ['task_admission_work_stage_check', 'c'],
  ['task_admission_work_state_check', 'c'],
  ['task_admission_work_task_id_fkey', 'f'],
  [
    'task_admission_work_workspace_materialization_deadline_ms_check',
    'c',
  ],
];
const EXPECTED_WORK_INDEXES = [
  'task_admission_work_pkey',
  'task_admission_work_state_available_at_created_at_task_id_idx',
  'task_admission_work_state_lease_until_created_at_task_id_idx',
];
const LEGACY_PROVISIONING_FAILURE_CODES = [
  'provisioning_capacity_exhausted',
  'provisioning_workspace_timeout',
  'provisioning_forge_auth_failed',
  'provisioning_tls_network_failed',
  'provisioning_ref_not_found',
  'provisioning_unknown',
];
const PROVISIONING_FAILURE_CODES = [
  ...LEGACY_PROVISIONING_FAILURE_CODES.slice(0, -1),
  PLATFORM_DEPENDENCY_FAILURE_CODE,
  'provisioning_unknown',
];
const LEGACY_TASK_FAILURE_CODES = [
  'runtime_auth_expired',
  'runtime_auth_rejected',
  'runtime_model_setup_failed',
  'runtime_model_rejected',
  ...LEGACY_PROVISIONING_FAILURE_CODES,
];
const FORBIDDEN_DURABLE_COLUMN =
  /(credential|secret|auth|header|argv|command|diagnostic|error|log|output|raw)/i;

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePrismaDir = path.join(apiDir, 'prisma');
const sourceMigrationsDir = path.join(sourcePrismaDir, 'migrations');
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (process.env.CAP_TASK_ADMISSION_MIGRATION_TEST !== '1') {
  throw new Error(
    'Refusing destructive migration test without CAP_TASK_ADMISSION_MIGRATION_TEST=1',
  );
}
const parsedUrl = new URL(databaseUrl);
if (!['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname)) {
  throw new Error('Migration test DATABASE_URL must target a loopback host');
}

const migrationNames = readdirSync(sourceMigrationsDir);
assert.ok(
  migrationNames.includes(RESOURCE_MIGRATION),
  `missing resource migration ${RESOURCE_MIGRATION}`,
);
const sandboxGenerationMigrationSql = readFileSync(
  path.join(
    sourceMigrationsDir,
    SANDBOX_RUN_GENERATION_MIGRATION,
    'migration.sql',
  ),
  'utf8',
);
assert.match(sandboxGenerationMigrationSql, /RAISE EXCEPTION/);
assert.doesNotMatch(
  sandboxGenerationMigrationSql,
  /UPDATE\s+"sandbox_runs"\s+AS\s+run\s+SET\s+"status"\s*=\s*'failed'/i,
  'generation migration must fail on duplicate live owners instead of guessing',
);
assert.ok(
  migrationNames.includes(ADMISSION_MIGRATION),
  `missing admission migration ${ADMISSION_MIGRATION}`,
);
assert.ok(
  migrationNames.includes(VALIDATION_RESOURCE_MIGRATION),
  `missing validation resource migration ${VALIDATION_RESOURCE_MIGRATION}`,
);
assert.ok(
  migrationNames.includes(ADMISSION_DEADLINE_MIGRATION),
  `missing admission deadline migration ${ADMISSION_DEADLINE_MIGRATION}`,
);
assert.ok(
  migrationNames.includes(SANDBOX_RUN_GENERATION_MIGRATION),
  `missing sandbox owner generation migration ${SANDBOX_RUN_GENERATION_MIGRATION}`,
);
assert.ok(
  migrationNames.includes(LEGACY_AIO_IDENTITY_MIGRATION),
  `missing legacy AIO identity migration ${LEGACY_AIO_IDENTITY_MIGRATION}`,
);
assert.ok(
  migrationNames.includes(PLATFORM_DEPENDENCY_FAILURE_MIGRATION),
  `missing platform dependency failure migration ${PLATFORM_DEPENDENCY_FAILURE_MIGRATION}`,
);
assert.ok(
  migrationNames.includes(PROVISIONING_DIAGNOSTICS_MIGRATION),
  `missing provisioning diagnostics migration ${PROVISIONING_DIAGNOSTICS_MIGRATION}`,
);
const provisioningDiagnosticsMigrationSql = readFileSync(
  path.join(
    sourceMigrationsDir,
    PROVISIONING_DIAGNOSTICS_MIGRATION,
    'migration.sql',
  ),
  'utf8',
);
assert.doesNotMatch(
  provisioningDiagnosticsMigrationSql,
  /\b(?:UPDATE|INSERT\s+INTO)\s+"(?:tasks|audit_events)"/i,
  'additive diagnostics migration must not copy evidence into Task or audit prose',
);
assert.match(
  provisioningDiagnosticsMigrationSql,
  /CREATE INDEX "task_provisioning_diagnostic_attempts_state_started_at_idx"\s+ON "task_provisioning_diagnostic_attempts"\("state", "started_at"\)/,
  'durable active-attempt gauges require the bounded state/age index',
);
assert.match(
  provisioningDiagnosticsMigrationSql,
  /CREATE INDEX "sandbox_runs_status_cleanup_orphan_confirmed_at_idx"\s+ON "sandbox_runs"\("status", "cleanup_orphan_confirmed_at"\)/,
  'durable cleanup/orphan gauges require the bounded status/evidence index',
);
assert.match(
  provisioningDiagnosticsMigrationSql,
  /"state" IN \('retrying', 'running'\)/,
  'retry cause provenance must remain compatible with rolling old writers',
);

const tempRoot = mkdtempSync(path.join(tmpdir(), 'cap-task-admission-migration-'));
const oldPrismaDir = path.join(tempRoot, 'prisma');
const oldMigrationsDir = path.join(oldPrismaDir, 'migrations');
const preDeadlinePrismaDir = path.join(tempRoot, 'pre-deadline-prisma');
const preDeadlineMigrationsDir = path.join(
  preDeadlinePrismaDir,
  'migrations',
);
const preLegacyAioIdentityPrismaDir = path.join(
  tempRoot,
  'pre-legacy-aio-identity-prisma',
);
const preLegacyAioIdentityMigrationsDir = path.join(
  preLegacyAioIdentityPrismaDir,
  'migrations',
);
const prePlatformDependencyPrismaDir = path.join(
  tempRoot,
  'pre-platform-dependency-prisma',
);
const prePlatformDependencyMigrationsDir = path.join(
  prePlatformDependencyPrismaDir,
  'migrations',
);
const preProvisioningDiagnosticsPrismaDir = path.join(
  tempRoot,
  'pre-provisioning-diagnostics-prisma',
);
const preProvisioningDiagnosticsMigrationsDir = path.join(
  preProvisioningDiagnosticsPrismaDir,
  'migrations',
);

function client() {
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

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
  const prisma = client();
  try {
    await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS "public" CASCADE');
    await prisma.$executeRawUnsafe('CREATE SCHEMA "public"');
  } finally {
    await prisma.$disconnect();
  }
}

function preparePreResourceMigrationFixture() {
  mkdirSync(oldMigrationsDir, { recursive: true });
  cpSync(
    path.join(sourcePrismaDir, 'schema.prisma'),
    path.join(oldPrismaDir, 'schema.prisma'),
  );
  cpSync(
    path.join(sourceMigrationsDir, 'migration_lock.toml'),
    path.join(oldMigrationsDir, 'migration_lock.toml'),
  );
  for (const name of migrationNames) {
    if (name < RESOURCE_MIGRATION && name !== 'migration_lock.toml') {
      cpSync(
        path.join(sourceMigrationsDir, name),
        path.join(oldMigrationsDir, name),
        { recursive: true },
      );
    }
  }
}

function preparePreDeadlineMigrationFixture() {
  mkdirSync(preDeadlineMigrationsDir, { recursive: true });
  cpSync(
    path.join(sourcePrismaDir, 'schema.prisma'),
    path.join(preDeadlinePrismaDir, 'schema.prisma'),
  );
  cpSync(
    path.join(sourceMigrationsDir, 'migration_lock.toml'),
    path.join(preDeadlineMigrationsDir, 'migration_lock.toml'),
  );
  for (const name of migrationNames) {
    if (
      name < ADMISSION_DEADLINE_MIGRATION &&
      name !== 'migration_lock.toml'
    ) {
      cpSync(
        path.join(sourceMigrationsDir, name),
        path.join(preDeadlineMigrationsDir, name),
        { recursive: true },
      );
    }
  }
}

function preparePreLegacyAioIdentityMigrationFixture() {
  mkdirSync(preLegacyAioIdentityMigrationsDir, { recursive: true });
  cpSync(
    path.join(sourcePrismaDir, 'schema.prisma'),
    path.join(preLegacyAioIdentityPrismaDir, 'schema.prisma'),
  );
  cpSync(
    path.join(sourceMigrationsDir, 'migration_lock.toml'),
    path.join(preLegacyAioIdentityMigrationsDir, 'migration_lock.toml'),
  );
  for (const name of migrationNames) {
    if (
      name < LEGACY_AIO_IDENTITY_MIGRATION &&
      name !== 'migration_lock.toml'
    ) {
      cpSync(
        path.join(sourceMigrationsDir, name),
        path.join(preLegacyAioIdentityMigrationsDir, name),
        { recursive: true },
      );
    }
  }
}

function preparePrePlatformDependencyMigrationFixture() {
  mkdirSync(prePlatformDependencyMigrationsDir, { recursive: true });
  cpSync(
    path.join(sourcePrismaDir, 'schema.prisma'),
    path.join(prePlatformDependencyPrismaDir, 'schema.prisma'),
  );
  cpSync(
    path.join(sourceMigrationsDir, 'migration_lock.toml'),
    path.join(prePlatformDependencyMigrationsDir, 'migration_lock.toml'),
  );
  for (const name of migrationNames) {
    if (
      name < PLATFORM_DEPENDENCY_FAILURE_MIGRATION &&
      name !== 'migration_lock.toml'
    ) {
      cpSync(
        path.join(sourceMigrationsDir, name),
        path.join(prePlatformDependencyMigrationsDir, name),
        { recursive: true },
      );
    }
  }
}

function preparePreProvisioningDiagnosticsMigrationFixture() {
  mkdirSync(preProvisioningDiagnosticsMigrationsDir, { recursive: true });
  cpSync(
    path.join(sourcePrismaDir, 'schema.prisma'),
    path.join(preProvisioningDiagnosticsPrismaDir, 'schema.prisma'),
  );
  cpSync(
    path.join(sourceMigrationsDir, 'migration_lock.toml'),
    path.join(preProvisioningDiagnosticsMigrationsDir, 'migration_lock.toml'),
  );
  for (const name of migrationNames) {
    if (
      name < PROVISIONING_DIAGNOSTICS_MIGRATION &&
      name !== 'migration_lock.toml'
    ) {
      cpSync(
        path.join(sourceMigrationsDir, name),
        path.join(preProvisioningDiagnosticsMigrationsDir, name),
        { recursive: true },
      );
    }
  }
}

async function readDiagnosticCoverageFixture(prisma, taskId) {
  const [row] = await prisma.$queryRawUnsafe(
    `
      SELECT
        task."provisioning_diagnostic_schema_version" AS schema_version,
        task."provisioning_diagnostic_next_attempt" AS next_attempt,
        count(attempt."id")::integer AS attempt_count,
        CASE
          WHEN task."provisioning_diagnostic_schema_version" IS NULL
            THEN 'unavailable'
          WHEN task."provisioning_diagnostic_next_attempt" > 1
               AND count(attempt."id") = 0
            THEN 'partial'
          ELSE 'not_started'
        END AS coverage
      FROM "tasks" AS task
      LEFT JOIN "task_provisioning_diagnostic_attempts" AS attempt
        ON attempt."task_id" = task."id"
      WHERE task."id" = $1
      GROUP BY task."id"
    `,
    taskId,
  );
  return row;
}

async function seedPreProvisioningDiagnosticsRows() {
  const prisma = client();
  try {
    const [diagnosticColumns] = await prisma.$queryRawUnsafe(`
      SELECT count(*)::integer AS count
      FROM "information_schema"."columns"
      WHERE "table_schema" = 'public'
        AND "table_name" = 'tasks'
        AND "column_name" LIKE 'provisioning_diagnostic_%'
    `);
    assert.equal(
      diagnosticColumns.count,
      0,
      'upgrade fixture must stop before the diagnostics expectation columns',
    );
    assert.equal(
      await prisma
        .$queryRawUnsafe(
          `SELECT to_regclass('public.task_provisioning_diagnostic_attempts')::text AS relation`,
        )
        .then(([row]) => row.relation),
      null,
      'upgrade fixture must stop before the diagnostics ledger tables',
    );

    await prisma.$executeRawUnsafe(`
      INSERT INTO "users" ("id", "name", "allowed")
      VALUES ('pre-diagnostics-user', 'Pre Diagnostics User', true)
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "repos" ("id", "name", "git_source")
      VALUES (
        'pre-diagnostics-repo',
        'Pre Diagnostics Repo',
        'https://example.invalid/pre-diagnostics.git'
      )
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "tasks" (
        "id", "repo_id", "owner_user_id", "prompt", "status",
        "failure_code", "failure_at"
      ) VALUES
        (
          'pre-diagnostics-task',
          'pre-diagnostics-repo',
          'pre-diagnostics-user',
          'historical task must remain byte-for-byte compatible',
          'failed',
          'provisioning_unknown',
          CURRENT_TIMESTAMP
        ),
        (
          'pre-diagnostics-generation-failed-task',
          'pre-diagnostics-repo',
          'pre-diagnostics-user',
          'historical generation failure without work is retained',
          'failed',
          'provisioning_unknown',
          CURRENT_TIMESTAMP
        ),
        (
          'pre-diagnostics-generation-claimable-task',
          'pre-diagnostics-repo',
          'pre-diagnostics-user',
          'historical generation failure with claimable work is reconciled',
          'failed',
          'provisioning_unknown',
          CURRENT_TIMESTAMP
        ),
        (
          'pre-diagnostics-generation-claimable-deleting-task',
          'pre-diagnostics-repo',
          'pre-diagnostics-user',
          'historical deleting generation with claimable work stays pending',
          'failed',
          'provisioning_unknown',
          CURRENT_TIMESTAMP
        ),
        (
          'pre-diagnostics-generation-entered-failed-task',
          'pre-diagnostics-repo',
          'pre-diagnostics-user',
          'historical entered failure has no late-create callback',
          'failed',
          'provisioning_unknown',
          CURRENT_TIMESTAMP
        ),
        (
          'pre-diagnostics-generation-entered-deleting-task',
          'pre-diagnostics-repo',
          'pre-diagnostics-user',
          'historical entered deleting has no late-create callback',
          'failed',
          'provisioning_unknown',
          CURRENT_TIMESTAMP
        ),
        (
          'pre-diagnostics-generation-settled-work-task',
          'pre-diagnostics-repo',
          'pre-diagnostics-user',
          'historical generation failure with terminal work is retained',
          'failed',
          'provisioning_unknown',
          CURRENT_TIMESTAMP
        ),
        (
          'pre-diagnostics-ownerless-failed-task',
          'pre-diagnostics-repo',
          'pre-diagnostics-user',
          'historical ownerless failure is retained',
          'failed',
          'provisioning_unknown',
          CURRENT_TIMESTAMP
        ),
        (
          'pre-diagnostics-generation-deleting-task',
          'pre-diagnostics-repo',
          'pre-diagnostics-user',
          'historical deleting owner remains pending',
          'failed',
          'provisioning_unknown',
          CURRENT_TIMESTAMP
        ),
        (
          'pre-diagnostics-retrying-task',
          'pre-diagnostics-repo',
          'pre-diagnostics-user',
          'historical retry lacks cause provenance',
          'pending',
          NULL,
          NULL
        )
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "task_admission_work" (
        "task_id", "state", "attempt", "stage", "cause_code",
        "created_at", "updated_at"
      ) VALUES
        (
          'pre-diagnostics-generation-claimable-deleting-task',
          'succeeded',
          1,
          'complete',
          NULL,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        ),
        (
          'pre-diagnostics-generation-claimable-task',
          'succeeded',
          1,
          'complete',
          NULL,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        ),
        (
          'pre-diagnostics-generation-entered-deleting-task',
          'succeeded',
          1,
          'complete',
          NULL,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        ),
        (
          'pre-diagnostics-generation-entered-failed-task',
          'succeeded',
          1,
          'complete',
          NULL,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        ),
        (
          'pre-diagnostics-generation-settled-work-task',
          'failed',
          1,
          'sandbox_creation',
          'provisioning_unknown',
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        ),
        (
          'pre-diagnostics-retrying-task',
          'retrying',
          1,
          'remote_ref_resolution',
          NULL,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "audit_events" (
        "id", "task_id", "user_id", "type", "level", "title",
        "description", "result_code"
      ) VALUES (
        'pre-diagnostics-audit',
        'pre-diagnostics-task',
        'pre-diagnostics-user',
        'task.failed',
        'error',
        'Historical failure',
        'Historical audit prose remains unchanged',
        500
      )
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "sandbox_runs" (
        "id", "task_id", "provider_id", "provider_sandbox_id",
        "owner_generation", "resource_generation", "create_state", "status",
        "updated_at"
      ) VALUES
        (
          'pre-diagnostics-run',
          'pre-diagnostics-task',
          'boxlite',
          'pre-diagnostics-provider-owner',
          NULL,
          NULL,
          'idle',
          'running',
          CURRENT_TIMESTAMP
        ),
        (
          'pre-diagnostics-generation-failed-run',
          'pre-diagnostics-generation-failed-task',
          'boxlite',
          'pre-diagnostics-generation-failed-owner',
          'historical-owner-generation',
          'historical-resource-generation',
          'idle',
          'failed',
          CURRENT_TIMESTAMP
        ),
        (
          'pre-diagnostics-generation-claimable-run',
          'pre-diagnostics-generation-claimable-task',
          'boxlite',
          'pre-diagnostics-generation-claimable-owner',
          'claimable-owner-generation',
          'claimable-resource-generation',
          'idle',
          'failed',
          CURRENT_TIMESTAMP
        ),
        (
          'pre-diagnostics-generation-claimable-deleting-run',
          'pre-diagnostics-generation-claimable-deleting-task',
          'boxlite',
          'pre-diagnostics-generation-claimable-deleting-owner',
          'claimable-deleting-owner-generation',
          'claimable-deleting-resource-generation',
          'idle',
          'deleting',
          CURRENT_TIMESTAMP
        ),
        (
          'pre-diagnostics-generation-entered-failed-run',
          'pre-diagnostics-generation-entered-failed-task',
          'boxlite',
          'pre-diagnostics-generation-entered-failed-owner',
          'entered-failed-owner-generation',
          'entered-failed-resource-generation',
          'entered',
          'failed',
          CURRENT_TIMESTAMP
        ),
        (
          'pre-diagnostics-generation-entered-deleting-run',
          'pre-diagnostics-generation-entered-deleting-task',
          'boxlite',
          'pre-diagnostics-generation-entered-deleting-owner',
          'entered-deleting-owner-generation',
          'entered-deleting-resource-generation',
          'entered',
          'deleting',
          CURRENT_TIMESTAMP
        ),
        (
          'pre-diagnostics-generation-settled-work-run',
          'pre-diagnostics-generation-settled-work-task',
          'boxlite',
          'pre-diagnostics-generation-settled-work-owner',
          'settled-work-owner-generation',
          'settled-work-resource-generation',
          'idle',
          'failed',
          CURRENT_TIMESTAMP
        ),
        (
          'pre-diagnostics-ownerless-failed-run',
          'pre-diagnostics-ownerless-failed-task',
          'boxlite',
          'pre-diagnostics-ownerless-failed-owner',
          NULL,
          NULL,
          'idle',
          'failed',
          CURRENT_TIMESTAMP
        ),
        (
          'pre-diagnostics-generation-deleting-run',
          'pre-diagnostics-generation-deleting-task',
          'boxlite',
          'pre-diagnostics-generation-deleting-owner',
          'historical-deleting-owner-generation',
          'historical-deleting-resource-generation',
          'idle',
          'deleting',
          CURRENT_TIMESTAMP
        )
    `);
  } finally {
    await prisma.$disconnect();
  }
}

async function verifyProvisioningDiagnosticsUpgradeCompatibility() {
  const prisma = client();
  try {
    const [task] = await prisma.$queryRawUnsafe(`
      SELECT
        "prompt", "status", "failure_code",
        "provisioning_diagnostic_schema_version" AS schema_version,
        "provisioning_diagnostic_next_attempt" AS next_attempt
      FROM "tasks"
      WHERE "id" = 'pre-diagnostics-task'
    `);
    assert.deepEqual(task, {
      prompt: 'historical task must remain byte-for-byte compatible',
      status: 'failed',
      failure_code: 'provisioning_unknown',
      schema_version: null,
      next_attempt: null,
    });
    const [historicalRetry] = await prisma.$queryRawUnsafe(`
      SELECT "state", "cause_code"
      FROM "task_admission_work"
      WHERE "task_id" = 'pre-diagnostics-retrying-task'
    `);
    assert.deepEqual(historicalRetry, {
      state: 'retrying',
      cause_code: 'provisioning_unknown',
    });
    assert.deepEqual(
      await readDiagnosticCoverageFixture(prisma, 'pre-diagnostics-task'),
      {
        schema_version: null,
        next_attempt: null,
        attempt_count: 0,
        coverage: 'unavailable',
      },
      'a historical task remains explicitly distinguishable as unavailable',
    );

    const [audit] = await prisma.$queryRawUnsafe(`
      SELECT "type", "level", "title", "description", "result_code"
      FROM "audit_events"
      WHERE "id" = 'pre-diagnostics-audit'
    `);
    assert.deepEqual(audit, {
      type: 'task.failed',
      level: 'error',
      title: 'Historical failure',
      description: 'Historical audit prose remains unchanged',
      result_code: 500,
    });

    const [run] = await prisma.$queryRawUnsafe(`
      SELECT
        "status", "provider_sandbox_id",
        "cleanup_attempt_in_flight", "cleanup_attempt_count",
        "cleanup_last_attempt_id", "cleanup_last_outcome",
        "cleanup_last_proof", "cleanup_last_cause",
        "cleanup_last_retryable", "cleanup_last_observed_at",
        "cleanup_orphan_confirmed_at"
      FROM "sandbox_runs"
      WHERE "id" = 'pre-diagnostics-run'
    `);
    assert.deepEqual(run, {
      status: 'running',
      provider_sandbox_id: 'pre-diagnostics-provider-owner',
      cleanup_attempt_in_flight: false,
      cleanup_attempt_count: 0,
      cleanup_last_attempt_id: null,
      cleanup_last_outcome: null,
      cleanup_last_proof: null,
      cleanup_last_cause: null,
      cleanup_last_retryable: null,
      cleanup_last_observed_at: null,
      cleanup_orphan_confirmed_at: null,
    });
    const historicalGenerationCleanup = await prisma.$queryRawUnsafe(`
      SELECT
        "id", "status", "owner_generation", "resource_generation", "create_state",
        "cleanup_attempt_count", "cleanup_last_outcome"
      FROM "sandbox_runs"
      WHERE "id" IN (
        'pre-diagnostics-generation-failed-run',
        'pre-diagnostics-generation-claimable-deleting-run',
        'pre-diagnostics-generation-claimable-run',
        'pre-diagnostics-generation-entered-deleting-run',
        'pre-diagnostics-generation-entered-failed-run',
        'pre-diagnostics-generation-settled-work-run',
        'pre-diagnostics-ownerless-failed-run',
        'pre-diagnostics-generation-deleting-run'
      )
      ORDER BY "id"
    `);
    assert.deepEqual(historicalGenerationCleanup, [
      {
        id: 'pre-diagnostics-generation-claimable-deleting-run',
        status: 'deleting',
        owner_generation: 'claimable-deleting-owner-generation',
        resource_generation: 'claimable-deleting-resource-generation',
        create_state: 'idle',
        cleanup_attempt_count: 0,
        cleanup_last_outcome: null,
      },
      {
        id: 'pre-diagnostics-generation-claimable-run',
        status: 'deleting',
        owner_generation: 'claimable-owner-generation',
        resource_generation: 'claimable-resource-generation',
        create_state: 'idle',
        cleanup_attempt_count: 0,
        cleanup_last_outcome: null,
      },
      {
        id: 'pre-diagnostics-generation-deleting-run',
        status: 'terminal',
        owner_generation: 'historical-deleting-owner-generation',
        resource_generation: 'historical-deleting-resource-generation',
        create_state: 'idle',
        cleanup_attempt_count: 0,
        cleanup_last_outcome: null,
      },
      {
        id: 'pre-diagnostics-generation-entered-deleting-run',
        status: 'terminal',
        owner_generation: 'entered-deleting-owner-generation',
        resource_generation: 'entered-deleting-resource-generation',
        create_state: 'entered',
        cleanup_attempt_count: 0,
        cleanup_last_outcome: null,
      },
      {
        id: 'pre-diagnostics-generation-entered-failed-run',
        status: 'terminal',
        owner_generation: 'entered-failed-owner-generation',
        resource_generation: 'entered-failed-resource-generation',
        create_state: 'entered',
        cleanup_attempt_count: 0,
        cleanup_last_outcome: null,
      },
      {
        id: 'pre-diagnostics-generation-failed-run',
        status: 'terminal',
        owner_generation: 'historical-owner-generation',
        resource_generation: 'historical-resource-generation',
        create_state: 'idle',
        cleanup_attempt_count: 0,
        cleanup_last_outcome: null,
      },
      {
        id: 'pre-diagnostics-generation-settled-work-run',
        status: 'terminal',
        owner_generation: 'settled-work-owner-generation',
        resource_generation: 'settled-work-resource-generation',
        create_state: 'idle',
        cleanup_attempt_count: 0,
        cleanup_last_outcome: null,
      },
      {
        id: 'pre-diagnostics-ownerless-failed-run',
        status: 'terminal',
        owner_generation: null,
        resource_generation: null,
        create_state: 'idle',
        cleanup_attempt_count: 0,
        cleanup_last_outcome: null,
      },
    ], 'only historical cleanup rows with a durable claim path remain deleting');
    const historicalWorkEligibility = await prisma.$queryRawUnsafe(`
      SELECT
        work."task_id" AS task_id,
        (
          (
            work."state" IN ('accepted', 'queued', 'retrying', 'running') OR (
              work."state" = 'succeeded' AND
              task."status"::text IN (
                'completed', 'failed', 'cancelled', 'agent_failed_to_start'
              )
            )
          ) AND
          EXISTS (
            SELECT 1
            FROM "sandbox_runs" AS run
            WHERE
              run."task_id" = work."task_id" AND
              run."status" IN ('provisioning', 'running', 'deleting') AND
              run."owner_generation" IS NOT NULL AND
              run."resource_generation" IS NOT NULL AND
              run."create_state" = 'idle'
          )
        ) AS recovery_eligible
      FROM "task_admission_work" AS work
      INNER JOIN "tasks" AS task ON task."id" = work."task_id"
      WHERE work."task_id" IN (
        'pre-diagnostics-generation-claimable-deleting-task',
        'pre-diagnostics-generation-claimable-task',
        'pre-diagnostics-generation-entered-deleting-task',
        'pre-diagnostics-generation-entered-failed-task',
        'pre-diagnostics-generation-settled-work-task'
      )
      ORDER BY work."task_id"
    `);
    assert.deepEqual(historicalWorkEligibility, [
      {
        task_id: 'pre-diagnostics-generation-claimable-deleting-task',
        recovery_eligible: true,
      },
      {
        task_id: 'pre-diagnostics-generation-claimable-task',
        recovery_eligible: true,
      },
      {
        task_id: 'pre-diagnostics-generation-entered-deleting-task',
        recovery_eligible: false,
      },
      {
        task_id: 'pre-diagnostics-generation-entered-failed-task',
        recovery_eligible: false,
      },
      {
        task_id: 'pre-diagnostics-generation-settled-work-task',
        recovery_eligible: false,
      },
    ], 'migration recovery requires both a durable claim path and an idle create fence');
    const [historicalFailedCount] = await prisma.$queryRawUnsafe(`
      SELECT count(*)::integer AS count
      FROM "sandbox_runs"
      WHERE "status" = 'failed'
    `);
    assert.equal(
      historicalFailedCount.count,
      0,
      'pre-policy failed rows cannot survive as atomic policy decisions',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "tasks"
        SET "provisioning_diagnostic_schema_version" = 1,
            "provisioning_diagnostic_next_attempt" = 1
        WHERE "id" = 'pre-diagnostics-task'
      `),
      'a historical task cannot be relabeled as diagnostics-capable after upgrade',
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function insertDiagnosticTask(prisma, taskId, nextAttempt = 1) {
  await prisma.$executeRawUnsafe(
    `
      INSERT INTO "tasks" (
        "id", "repo_id", "owner_user_id", "prompt",
        "provisioning_diagnostic_schema_version",
        "provisioning_diagnostic_next_attempt"
      ) VALUES (
        $1, 'diagnostics-repo', 'diagnostics-user', $2, 1, $3
      )
    `,
    taskId,
    `diagnostic migration fixture ${taskId}`,
    nextAttempt,
  );
}

async function insertTerminalDiagnosticAttempt(
  prisma,
  {
    id,
    taskId,
    attemptNumber,
    cleanupState = 'not_required',
    eventCount = 0,
  },
) {
  const cleanupPending = cleanupState === 'pending';
  await prisma.$executeRawUnsafe(
    `
      INSERT INTO "task_provisioning_diagnostic_attempts" (
        "id", "task_id", "schema_version", "attempt_number",
        "admission_mode", "provider_family", "state", "stage", "coverage",
        "primary_outcome", "primary_cause", "primary_retryable",
        "primary_exit_code", "primary_observed_at",
        "cleanup_state", "cleanup_cause", "cleanup_attempt_count",
        "cleanup_last_attempt_outcome", "cleanup_observed_at",
        "event_count", "truncated", "started_at", "finished_at",
        "completeness_marked_at", "updated_at"
      ) VALUES (
        $1, $2, 1, $3,
        'durable', 'boxlite', 'failed', 'runtime_setup', $4,
        'failed', 'command_failed', false,
        17, CURRENT_TIMESTAMP,
        $5, $6, $7,
        $8, $9,
        $11, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
        $10, CURRENT_TIMESTAMP
      )
    `,
    id,
    taskId,
    attemptNumber,
    cleanupPending ? 'partial' : 'complete',
    cleanupState,
    cleanupPending ? 'cleanup_unconfirmed' : null,
    cleanupPending ? 1 : 0,
    cleanupPending ? 'failed' : null,
    cleanupPending ? new Date() : null,
    cleanupPending ? null : new Date(),
    eventCount,
  );
}

async function insertActiveDiagnosticAttempt(
  prisma,
  { id, taskId, attemptNumber, providerFamily = 'boxlite' },
) {
  await prisma.$executeRawUnsafe(
    `
      INSERT INTO "task_provisioning_diagnostic_attempts" (
        "id", "task_id", "schema_version", "attempt_number",
        "admission_mode", "provider_family", "state", "stage", "coverage",
        "updated_at"
      ) VALUES (
        $1, $2, 1, $3,
        'durable', $4, 'active', 'sandbox_creation', 'partial',
        CURRENT_TIMESTAMP
      )
    `,
    id,
    taskId,
    attemptNumber,
    providerFamily,
  );
}

async function insertTerminalDiagnosticEvent(
  prisma,
  {
    id,
    attemptId,
    taskId,
    sequence,
    idempotencyKey,
    operationId,
    schemaVersion = 1,
    channel = 'primary',
    anomaly = null,
  },
) {
  await prisma.$executeRawUnsafe(
    `
      INSERT INTO "task_provisioning_diagnostic_events" (
        "id", "attempt_id", "task_id", "schema_version",
        "idempotency_key", "sequence", "operation_id",
        "admission_mode", "provider_family", "stage", "operation", "channel",
        "command_kind", "outcome", "observed_at", "duration_ms",
        "cause", "retryable", "native_state", "anomaly", "exit_code"
      ) VALUES (
        $1, $2, $3, $7,
        $4, $5, $6,
        'durable', 'boxlite', 'runtime_setup', 'runtime_setup', $8,
        'runtime_setup', 'failed', CURRENT_TIMESTAMP, 1200,
        'command_failed', false, 'failed', $9, 17
      )
    `,
    id,
    attemptId,
    taskId,
    idempotencyKey,
    sequence,
    operationId,
    schemaVersion,
    channel,
    anomaly,
  );
}

async function insertDiagnosticCompaction(prisma, taskId) {
  await prisma.$executeRawUnsafe(
    `
      INSERT INTO "task_provisioning_diagnostic_compactions" (
        "task_id", "compacted_attempt_from", "compacted_attempt_to",
        "compacted_attempt_count", "compacted_event_count",
        "truncation_count", "primary_failed_count",
        "cleanup_not_required_count", "compacted_at", "updated_at"
      ) VALUES ($1, 1, 1, 1, 1, 1, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `,
    taskId,
  );
}

async function seedLegacyAioIdentityRows() {
  const prisma = client();
  try {
    await prisma.$executeRawUnsafe(`
      INSERT INTO "users" ("id", "name", "allowed")
      VALUES ('legacy-aio-user', 'Legacy AIO User', true)
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "repos" ("id", "name", "git_source")
      VALUES (
        'legacy-aio-repo',
        'Legacy AIO Repo',
        'https://example.invalid/legacy-aio.git'
      )
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "tasks" (
        "id", "repo_id", "owner_user_id", "prompt", "status"
      ) VALUES
        (
          'legacy-aio-running', 'legacy-aio-repo', 'legacy-aio-user',
          'running legacy AIO owner', 'running'
        ),
        (
          'legacy-aio-awaiting', 'legacy-aio-repo', 'legacy-aio-user',
          'awaiting-input legacy AIO owner', 'awaiting_input'
        ),
        (
          'legacy-boxlite-running', 'legacy-aio-repo', 'legacy-aio-user',
          'another provider with a task-shaped identity', 'running'
        ),
        (
          'aio-physical-running', 'legacy-aio-repo', 'legacy-aio-user',
          'AIO owner with a physical identity', 'running'
        ),
        (
          'aio-fenced-running', 'legacy-aio-repo', 'legacy-aio-user',
          'generation-fenced AIO owner', 'running'
        ),
        (
          'aio-entered-running', 'legacy-aio-repo', 'legacy-aio-user',
          'AIO owner with unresolved create state', 'running'
        ),
        (
          'aio-completed-task', 'legacy-aio-repo', 'legacy-aio-user',
          'terminal task with a stale running owner', 'completed'
        ),
        (
          'aio-provisioning-run', 'legacy-aio-repo', 'legacy-aio-user',
          'AIO owner still provisioning', 'running'
        )
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "sandbox_runs" (
        "id", "task_id", "provider_id", "provider_sandbox_id",
        "owner_generation", "resource_generation", "create_state",
        "status", "updated_at"
      ) VALUES
        (
          'legacy-aio-running-run', 'legacy-aio-running', 'aio-local',
          'legacy-aio-running', NULL, NULL, 'idle', 'running', CURRENT_TIMESTAMP
        ),
        (
          'legacy-aio-awaiting-run', 'legacy-aio-awaiting', 'aio-local',
          'legacy-aio-awaiting', NULL, NULL, 'idle', 'running', CURRENT_TIMESTAMP
        ),
        (
          'legacy-boxlite-running-run', 'legacy-boxlite-running', 'boxlite',
          'legacy-boxlite-running', NULL, NULL, 'idle', 'running', CURRENT_TIMESTAMP
        ),
        (
          'aio-physical-running-run', 'aio-physical-running', 'aio-local',
          '713fe4fea93032345dec87763f9e5c02', NULL, NULL, 'idle', 'running',
          CURRENT_TIMESTAMP
        ),
        (
          'aio-fenced-running-run', 'aio-fenced-running', 'aio-local',
          'aio-fenced-running', 'owner-generation', 'resource-generation',
          'idle', 'running', CURRENT_TIMESTAMP
        ),
        (
          'aio-entered-running-run', 'aio-entered-running', 'aio-local',
          'aio-entered-running', NULL, NULL, 'entered', 'running', CURRENT_TIMESTAMP
        ),
        (
          'aio-completed-task-run', 'aio-completed-task', 'aio-local',
          'aio-completed-task', NULL, NULL, 'idle', 'running', CURRENT_TIMESTAMP
        ),
        (
          'aio-provisioning-run-row', 'aio-provisioning-run', 'aio-local',
          'aio-provisioning-run', NULL, NULL, 'entered', 'provisioning',
          CURRENT_TIMESTAMP
        )
    `);
  } finally {
    await prisma.$disconnect();
  }
}

async function verifyLegacyAioIdentityUpgrade() {
  const prisma = client();
  try {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT "task_id", "provider_sandbox_id"
      FROM "sandbox_runs"
      ORDER BY "task_id"
    `);
    assert.deepEqual(rows, [
      {
        task_id: 'aio-completed-task',
        provider_sandbox_id: 'aio-completed-task',
      },
      {
        task_id: 'aio-entered-running',
        provider_sandbox_id: 'aio-entered-running',
      },
      {
        task_id: 'aio-fenced-running',
        provider_sandbox_id: 'aio-fenced-running',
      },
      {
        task_id: 'aio-physical-running',
        provider_sandbox_id: '713fe4fea93032345dec87763f9e5c02',
      },
      {
        task_id: 'aio-provisioning-run',
        provider_sandbox_id: 'aio-provisioning-run',
      },
      {
        task_id: 'legacy-aio-awaiting',
        provider_sandbox_id: null,
      },
      {
        task_id: 'legacy-aio-running',
        provider_sandbox_id: null,
      },
      {
        task_id: 'legacy-boxlite-running',
        provider_sandbox_id: 'legacy-boxlite-running',
      },
    ]);
  } finally {
    await prisma.$disconnect();
  }
}

async function seedPrePlatformDependencyFailureRows() {
  const prisma = client();
  try {
    await prisma.$executeRawUnsafe(`
      INSERT INTO "users" ("id", "name", "allowed")
      VALUES ('platform-failure-user', 'Platform Failure User', true)
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "repos" ("id", "name", "git_source")
      VALUES (
        'platform-failure-repo',
        'Platform Failure Repo',
        'https://example.invalid/platform-failure.git'
      )
    `);

    for (const [index, failureCode] of LEGACY_TASK_FAILURE_CODES.entries()) {
      await prisma.$executeRawUnsafe(
        `
          INSERT INTO "tasks" (
            "id", "repo_id", "owner_user_id", "prompt", "status",
            "failure_code", "failure_at"
          ) VALUES ($1, 'platform-failure-repo', 'platform-failure-user', $2,
                    'failed', $3, CURRENT_TIMESTAMP)
        `,
        `legacy-platform-task-${String(index).padStart(2, '0')}`,
        `legacy failure ${failureCode}`,
        failureCode,
      );
    }
    for (const [index, causeCode] of LEGACY_PROVISIONING_FAILURE_CODES.entries()) {
      await prisma.$executeRawUnsafe(
        `
          INSERT INTO "task_admission_work" (
            "task_id", "state", "cause_code", "updated_at"
          ) VALUES ($1, 'failed', $2, CURRENT_TIMESTAMP)
        `,
        `legacy-platform-task-${String(index + 4).padStart(2, '0')}`,
        causeCode,
      );
    }

    await prisma.$executeRawUnsafe(`
      INSERT INTO "tasks" (
        "id", "repo_id", "owner_user_id", "prompt", "status"
      ) VALUES (
        'new-platform-dependency-task',
        'platform-failure-repo',
        'platform-failure-user',
        'platform dependency failure after upgrade',
        'pending'
      )
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "task_admission_work" ("task_id", "updated_at")
      VALUES ('new-platform-dependency-task', CURRENT_TIMESTAMP)
    `);

    await assert.rejects(
      prisma.$executeRawUnsafe(
        `
          UPDATE "tasks"
          SET "failure_code" = $1
          WHERE "id" = 'new-platform-dependency-task'
        `,
        PLATFORM_DEPENDENCY_FAILURE_CODE,
      ),
      undefined,
      'predecessor Task CHECK must reject the new platform dependency code',
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function verifyPlatformDependencyFailureUpgradeAndRollback() {
  const prisma = client();
  try {
    const legacyTaskRows = await prisma.$queryRawUnsafe(`
      SELECT "id", "failure_code"
      FROM "tasks"
      WHERE "id" LIKE 'legacy-platform-task-%'
      ORDER BY "id"
    `);
    assert.deepEqual(
      legacyTaskRows.map(({ failure_code }) => failure_code),
      LEGACY_TASK_FAILURE_CODES,
      'upgrade must not rewrite any predecessor Task failure value',
    );
    const legacyWorkRows = await prisma.$queryRawUnsafe(`
      SELECT "task_id", "cause_code"
      FROM "task_admission_work"
      WHERE "task_id" LIKE 'legacy-platform-task-%'
      ORDER BY "task_id"
    `);
    assert.deepEqual(
      legacyWorkRows.map(({ cause_code }) => cause_code),
      LEGACY_PROVISIONING_FAILURE_CODES,
      'upgrade must not rewrite any predecessor admission cause value',
    );

    const constraintRows = await prisma.$queryRawUnsafe(`
      SELECT constraint_row."conname",
             pg_get_constraintdef(constraint_row."oid") AS definition
      FROM "pg_constraint" AS constraint_row
      WHERE constraint_row."conname" IN (
        'tasks_failure_code_check',
        'task_admission_work_cause_code_check'
      )
      ORDER BY constraint_row."conname"
    `);
    assert.equal(constraintRows.length, 2);
    for (const row of constraintRows) {
      assert.match(row.definition, /provisioning_platform_dependency_unavailable/);
    }

    await prisma.$executeRawUnsafe(
      `
        UPDATE "tasks"
        SET "status" = 'failed', "failure_code" = $1,
            "failure_at" = CURRENT_TIMESTAMP
        WHERE "id" = 'new-platform-dependency-task'
      `,
      PLATFORM_DEPENDENCY_FAILURE_CODE,
    );
    await prisma.$executeRawUnsafe(
      `
        UPDATE "task_admission_work"
        SET "state" = 'failed', "cause_code" = $1
        WHERE "task_id" = 'new-platform-dependency-task'
      `,
      PLATFORM_DEPENDENCY_FAILURE_CODE,
    );

    const rollbackSql = readFileSync(
      path.join(
        sourceMigrationsDir,
        PLATFORM_DEPENDENCY_FAILURE_MIGRATION,
        'rollback.sql',
      ),
      'utf8',
    );
    const rollbackStatements = rollbackSql
      .replace(/^\s*--.*$/gmu, '')
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);
    assert.equal(
      rollbackStatements.length,
      2,
      'rollback artifact must contain only the Task and admission normalization writes',
    );
    await prisma.$transaction(async (tx) => {
      for (const statement of rollbackStatements) {
        await tx.$executeRawUnsafe(statement);
      }
    });

    const [normalizedTask] = await prisma.$queryRawUnsafe(`
      SELECT "failure_code", "failure_at"
      FROM "tasks"
      WHERE "id" = 'new-platform-dependency-task'
    `);
    assert.equal(normalizedTask.failure_code, 'provisioning_unknown');
    assert.ok(normalizedTask.failure_at instanceof Date);
    const [normalizedWork] = await prisma.$queryRawUnsafe(`
      SELECT "state", "cause_code"
      FROM "task_admission_work"
      WHERE "task_id" = 'new-platform-dependency-task'
    `);
    assert.deepEqual(normalizedWork, {
      state: 'failed',
      cause_code: 'provisioning_unknown',
    });

    const taskRowsAfterRollback = await prisma.$queryRawUnsafe(`
      SELECT "failure_code"
      FROM "tasks"
      WHERE "id" LIKE 'legacy-platform-task-%'
      ORDER BY "id"
    `);
    assert.deepEqual(
      taskRowsAfterRollback.map(({ failure_code }) => failure_code),
      LEGACY_TASK_FAILURE_CODES,
      'rollback normalization must leave every legacy Task failure untouched',
    );
    const workRowsAfterRollback = await prisma.$queryRawUnsafe(`
      SELECT "cause_code"
      FROM "task_admission_work"
      WHERE "task_id" LIKE 'legacy-platform-task-%'
      ORDER BY "task_id"
    `);
    assert.deepEqual(
      workRowsAfterRollback.map(({ cause_code }) => cause_code),
      LEGACY_PROVISIONING_FAILURE_CODES,
      'rollback normalization must leave every legacy admission cause untouched',
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function seedHistoricalRows() {
  const prisma = client();
  try {
    assert.equal(
      await prisma.$queryRawUnsafe(
        `SELECT to_regclass('public.task_admission_work')::text AS relation`,
      ).then(([row]) => row.relation),
      null,
      'predecessor schema must not contain admission work',
    );
    await prisma.$executeRawUnsafe(`
      INSERT INTO "users" ("id", "name", "allowed")
      VALUES ('admission-migration-user', 'Admission Migration User', true)
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "repos" ("id", "name", "git_source")
      VALUES (
        'admission-migration-repo',
        'Admission Migration Repo',
        'https://example.invalid/admission-migration.git'
      )
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "sandbox_environments" ("id", "name", "source")
      VALUES (
        'admission-migration-environment',
        'Admission Migration Environment',
        '{"kind":"docker-image","image":"example.invalid/cap:test"}'::jsonb
      )
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "tasks" (
        "id", "repo_id", "owner_user_id", "prompt", "sandbox_environment_id"
      ) VALUES (
        'historical-admission-task',
        'admission-migration-repo',
        'admission-migration-user',
        'historical task without admission work',
        'admission-migration-environment'
      )
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "sandbox_environment_validations" (
        "id", "environment_id", "status", "provider_family", "source_kind"
      ) VALUES (
        'historical-resource-validation',
        'admission-migration-environment',
        'passed',
        'boxlite',
        'boxlite-image'
      )
    `);
  } finally {
    await prisma.$disconnect();
  }
}

async function verifyHistoricalUpgrade() {
  const prisma = client();
  try {
    const [row] = await prisma.$queryRawUnsafe(`
      SELECT
        task."lifecycle_version",
        task."branch",
        task."model",
        task."execution_environment_snapshot",
        repo."default_branch",
        repo."forge",
        environment."resources"
      FROM "tasks" AS task
      JOIN "repos" AS repo ON repo."id" = task."repo_id"
      JOIN "sandbox_environments" AS environment
        ON environment."id" = task."sandbox_environment_id"
      WHERE task."id" = 'historical-admission-task'
    `);
    assert.deepEqual(row, {
      lifecycle_version: 0,
      branch: null,
      model: null,
      execution_environment_snapshot: null,
      default_branch: null,
      forge: null,
      resources: null,
    });
    const [validation] = await prisma.$queryRawUnsafe(`
      SELECT "resource_snapshot"
      FROM "sandbox_environment_validations"
      WHERE "id" = 'historical-resource-validation'
    `);
    assert.deepEqual(validation, { resource_snapshot: null });

    const [workCount] = await prisma.$queryRawUnsafe(`
      SELECT count(*)::integer AS count
      FROM "task_admission_work"
      WHERE "task_id" = 'historical-admission-task'
    `);
    assert.equal(
      workCount.count,
      0,
      'upgrade must not synthesize admission work for historical tasks',
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function seedPreDeadlineAdmissionWork() {
  const prisma = client();
  try {
    const [deadlineColumn] = await prisma.$queryRawUnsafe(`
      SELECT count(*)::integer AS count
      FROM "information_schema"."columns"
      WHERE "table_schema" = 'public'
        AND "table_name" = 'task_admission_work'
        AND "column_name" = 'workspace_materialization_deadline_ms'
    `);
    assert.equal(
      deadlineColumn.count,
      0,
      'pre-deadline fixture must stop after the validation-resource migration',
    );
    await prisma.$executeRawUnsafe(`
      INSERT INTO "users" ("id", "name", "allowed")
      VALUES ('pre-deadline-user', 'Pre Deadline User', true)
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "repos" ("id", "name", "git_source")
      VALUES (
        'pre-deadline-repo',
        'Pre Deadline Repo',
        'https://example.invalid/pre-deadline.git'
      )
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "tasks" ("id", "repo_id", "owner_user_id", "prompt")
      VALUES
        (
          'pre-deadline-task',
          'pre-deadline-repo',
          'pre-deadline-user',
          'admission work created before deadline snapshot migration'
        ),
        (
          'pre-generation-provisioning-task',
          'pre-deadline-repo',
          'pre-deadline-user',
          'historical provisioning sandbox run'
        ),
        (
          'pre-generation-deleting-task',
          'pre-deadline-repo',
          'pre-deadline-user',
          'historical deleting sandbox run'
        )
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "task_admission_work" (
        "task_id", "updated_at", "resolved_branch", "resource_snapshot"
      ) VALUES (
        'pre-deadline-task',
        CURRENT_TIMESTAMP,
        'master',
        '{"diskSizeGb":64}'::jsonb
      )
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "sandbox_runs" (
        "id", "task_id", "provider_id", "provider_sandbox_id",
        "status", "updated_at"
      ) VALUES
        (
          'pre-generation-sandbox-run',
          'pre-deadline-task',
          'boxlite',
          'box-pre-deadline-task',
          'running',
          CURRENT_TIMESTAMP
        ),
        (
          'pre-generation-provisioning-run',
          'pre-generation-provisioning-task',
          'boxlite',
          NULL,
          'provisioning',
          CURRENT_TIMESTAMP
        ),
        (
          'pre-generation-deleting-run',
          'pre-generation-deleting-task',
          'boxlite',
          NULL,
          'deleting',
          CURRENT_TIMESTAMP
        )
    `);
  } finally {
    await prisma.$disconnect();
  }
}

async function verifyPreDeadlineAdmissionWorkUpgrade() {
  const prisma = client();
  try {
    const [work] = await prisma.$queryRawUnsafe(`
      SELECT
        "resolved_branch",
        "resource_snapshot",
        "workspace_materialization_deadline_ms" AS deadline
      FROM "task_admission_work"
      WHERE "task_id" = 'pre-deadline-task'
    `);
    assert.deepEqual(work, {
      resolved_branch: 'master',
      resource_snapshot: { diskSizeGb: 64 },
      deadline: null,
    });
    const legacySandboxRuns = await prisma.$queryRawUnsafe(`
      SELECT "id", "owner_generation", "resource_generation", "create_state", "status"
      FROM "sandbox_runs"
      WHERE "id" LIKE 'pre-generation-%run'
      ORDER BY "id"
    `);
    assert.deepEqual(
      legacySandboxRuns,
      [
        {
          id: 'pre-generation-deleting-run',
          owner_generation: null,
          resource_generation: null,
          create_state: 'entered',
          status: 'terminal',
        },
        {
          id: 'pre-generation-provisioning-run',
          owner_generation: null,
          resource_generation: null,
          create_state: 'entered',
          status: 'provisioning',
        },
        {
          id: 'pre-generation-sandbox-run',
          owner_generation: null,
          resource_generation: null,
          create_state: 'idle',
          status: 'running',
        },
      ],
      'upgrade retains NULL generations and closes ownerless cleanup without a claim path',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "task_admission_work"
        SET "resolved_branch" = 'main'
        WHERE "task_id" = 'pre-deadline-task'
      `),
      'deadline migration must preserve the existing resolved-branch fence',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "task_admission_work"
        SET "resource_snapshot" = '{"diskSizeGb":128}'::jsonb
        WHERE "task_id" = 'pre-deadline-task'
      `),
      'deadline migration must preserve the existing resource-snapshot fence',
    );
    await prisma.$executeRawUnsafe(`
      UPDATE "task_admission_work"
      SET "workspace_materialization_deadline_ms" = 900000
      WHERE "task_id" = 'pre-deadline-task'
    `);
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "task_admission_work"
        SET "workspace_materialization_deadline_ms" = 900001
        WHERE "task_id" = 'pre-deadline-task'
      `),
      'a pre-deadline admission row may fill the new snapshot only once',
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function readFreshSchema(prisma) {
  const columns = await prisma.$queryRawUnsafe(`
    SELECT "column_name", "data_type", "is_nullable", "column_default"
    FROM "information_schema"."columns"
    WHERE "table_schema" = 'public'
      AND "table_name" = 'task_admission_work'
    ORDER BY "ordinal_position"
  `);
  const constraints = await prisma.$queryRawUnsafe(`
    SELECT constraint_row."conname", constraint_row."contype",
           pg_get_constraintdef(constraint_row."oid") AS definition
    FROM "pg_constraint" AS constraint_row
    JOIN "pg_class" AS relation
      ON relation."oid" = constraint_row."conrelid"
    JOIN "pg_namespace" AS namespace
      ON namespace."oid" = relation."relnamespace"
    WHERE namespace."nspname" = 'public'
      AND relation."relname" = 'task_admission_work'
    ORDER BY constraint_row."conname"
  `);
  const indexes = await prisma.$queryRawUnsafe(`
    SELECT "indexname", "indexdef"
    FROM "pg_indexes"
    WHERE "schemaname" = 'public'
      AND "tablename" = 'task_admission_work'
    ORDER BY "indexname"
  `);
  return { columns, constraints, indexes };
}

async function expectConstraintFailure(operation, label) {
  await assert.rejects(operation, undefined, label);
}

async function verifyFreshSchemaAndBehavior() {
  const prisma = client();
  try {
    const { columns, constraints, indexes } = await readFreshSchema(prisma);

    assert.deepEqual(
      columns.map(({ column_name, data_type, is_nullable }) => [
        column_name,
        data_type,
        is_nullable,
      ]),
      EXPECTED_WORK_COLUMNS,
      'admission work durable column set must remain exact and additive-safe',
    );
    assert.deepEqual(
      columns.filter(({ column_name }) =>
        FORBIDDEN_DURABLE_COLUMN.test(column_name),
      ),
      [],
      'admission work must not persist credential or raw diagnostic fields',
    );
    const defaults = Object.fromEntries(
      columns.map(({ column_name, column_default }) => [
        column_name,
        column_default,
      ]),
    );
    assert.match(defaults.state, /^'accepted'::text$/);
    assert.equal(defaults.attempt, '0');
    assert.match(defaults.available_at, /^CURRENT_TIMESTAMP$/);
    assert.match(defaults.stage, /^'accepted'::text$/);
    assert.match(defaults.created_at, /^CURRENT_TIMESTAMP$/);
    assert.equal(defaults.updated_at, null);

    assert.deepEqual(
      constraints.map(({ conname, contype }) => [conname, contype]),
      EXPECTED_WORK_CONSTRAINTS,
      'admission work PK, FK, and CHECK constraint set must remain exact',
    );
    const constraintDefinitions = Object.fromEntries(
      constraints.map(({ conname, definition }) => [conname, definition]),
    );
    assert.match(
      constraintDefinitions.task_admission_work_cause_code_check,
      /provisioning_platform_dependency_unavailable/,
      'fresh admission CHECK accepts the platform dependency cause',
    );
    assert.match(
      constraintDefinitions.task_admission_work_cause_shape_check,
      /retrying/,
      'retrying work must retain a closed cause for the next claim',
    );
    assert.match(
      constraintDefinitions.task_admission_work_pkey,
      /^PRIMARY KEY \(task_id\)$/,
    );
    assert.match(
      constraintDefinitions.task_admission_work_task_id_fkey,
      /^FOREIGN KEY \(task_id\) REFERENCES tasks\(id\) ON UPDATE CASCADE ON DELETE CASCADE$/,
    );

    assert.deepEqual(
      indexes.map(({ indexname }) => indexname),
      EXPECTED_WORK_INDEXES,
      'admission work must have only its unique key, ready queue, and lease indexes',
    );
    const indexDefinitions = Object.fromEntries(
      indexes.map(({ indexname, indexdef }) => [indexname, indexdef]),
    );
    assert.match(
      indexDefinitions.task_admission_work_state_available_at_created_at_task_id_idx,
      /USING btree \(state, available_at, created_at, task_id\)$/,
    );
    assert.match(
      indexDefinitions.task_admission_work_state_lease_until_created_at_task_id_idx,
      /USING btree \(state, lease_until, created_at, task_id\)$/,
    );

    const [taskFence] = await prisma.$queryRawUnsafe(`
      SELECT "is_nullable", "column_default"
      FROM "information_schema"."columns"
      WHERE "table_schema" = 'public'
        AND "table_name" = 'tasks'
        AND "column_name" = 'lifecycle_version'
    `);
    assert.deepEqual(taskFence, { is_nullable: 'NO', column_default: '0' });
    const [taskFenceConstraint] = await prisma.$queryRawUnsafe(`
      SELECT pg_get_constraintdef(constraint_row."oid") AS definition
      FROM "pg_constraint" AS constraint_row
      JOIN "pg_class" AS relation
        ON relation."oid" = constraint_row."conrelid"
      JOIN "pg_namespace" AS namespace
        ON namespace."oid" = relation."relnamespace"
      WHERE namespace."nspname" = 'public'
        AND relation."relname" = 'tasks'
        AND constraint_row."conname" = 'tasks_lifecycle_version_check'
    `);
    assert.match(taskFenceConstraint.definition, /lifecycle_version >= 0/);
    const [taskFailureConstraint] = await prisma.$queryRawUnsafe(`
      SELECT pg_get_constraintdef(constraint_row."oid") AS definition
      FROM "pg_constraint" AS constraint_row
      JOIN "pg_class" AS relation
        ON relation."oid" = constraint_row."conrelid"
      JOIN "pg_namespace" AS namespace
        ON namespace."oid" = relation."relnamespace"
      WHERE namespace."nspname" = 'public'
        AND relation."relname" = 'tasks'
        AND constraint_row."conname" = 'tasks_failure_code_check'
    `);
    assert.match(
      taskFailureConstraint.definition,
      /provisioning_platform_dependency_unavailable/,
      'fresh Task CHECK accepts the platform dependency failure',
    );

    const sandboxGenerationColumns = await prisma.$queryRawUnsafe(`
      SELECT "column_name", "data_type", "is_nullable", "column_default"
      FROM "information_schema"."columns"
      WHERE "table_schema" = 'public'
        AND "table_name" = 'sandbox_runs'
        AND "column_name" IN (
          'create_state',
          'owner_generation',
          'resource_generation'
        )
      ORDER BY "column_name"
    `);
    assert.deepEqual(sandboxGenerationColumns, [
      {
        column_name: 'create_state',
        data_type: 'text',
        is_nullable: 'NO',
        column_default: "'entered'::text",
      },
      {
        column_name: 'owner_generation',
        data_type: 'text',
        is_nullable: 'YES',
        column_default: null,
      },
      {
        column_name: 'resource_generation',
        data_type: 'text',
        is_nullable: 'YES',
        column_default: null,
      },
    ]);
    const [sandboxGenerationConstraint] = await prisma.$queryRawUnsafe(`
      SELECT pg_get_constraintdef(constraint_row."oid") AS definition
      FROM "pg_constraint" AS constraint_row
      JOIN "pg_class" AS relation
        ON relation."oid" = constraint_row."conrelid"
      JOIN "pg_namespace" AS namespace
        ON namespace."oid" = relation."relnamespace"
      WHERE namespace."nspname" = 'public'
        AND relation."relname" = 'sandbox_runs'
        AND constraint_row."conname" = 'sandbox_runs_generation_pair_check'
    `);
    assert.match(sandboxGenerationConstraint.definition, /owner_generation/);
    assert.match(sandboxGenerationConstraint.definition, /resource_generation/);
    const [sandboxCreateStateConstraint] = await prisma.$queryRawUnsafe(`
      SELECT pg_get_constraintdef(constraint_row."oid") AS definition
      FROM "pg_constraint" AS constraint_row
      JOIN "pg_class" AS relation
        ON relation."oid" = constraint_row."conrelid"
      JOIN "pg_namespace" AS namespace
        ON namespace."oid" = relation."relnamespace"
      WHERE namespace."nspname" = 'public'
        AND relation."relname" = 'sandbox_runs'
        AND constraint_row."conname" = 'sandbox_runs_create_state_check'
    `);
    assert.match(sandboxCreateStateConstraint.definition, /idle/);
    assert.match(sandboxCreateStateConstraint.definition, /entered/);
    const sandboxGenerationIndexes = await prisma.$queryRawUnsafe(`
      SELECT "indexname", "indexdef"
      FROM "pg_indexes"
      WHERE "schemaname" = 'public'
        AND "tablename" = 'sandbox_runs'
        AND "indexname" IN (
          'sandbox_runs_one_live_owner_per_task_idx',
          'sandbox_runs_task_id_owner_generation_resource_generation_idx'
        )
      ORDER BY "indexname"
    `);
    assert.deepEqual(
      sandboxGenerationIndexes.map(({ indexname }) => indexname),
      [
        'sandbox_runs_one_live_owner_per_task_idx',
        'sandbox_runs_task_id_owner_generation_resource_generation_idx',
      ],
    );
    assert.match(
      sandboxGenerationIndexes[0].indexdef,
      /UNIQUE.*task_id.*WHERE.*provisioning.*running.*deleting/i,
    );
    assert.match(
      constraintDefinitions.task_admission_work_cause_shape_check,
      /state.*running/i,
    );

    const [validationResourceColumn] = await prisma.$queryRawUnsafe(`
      SELECT "data_type", "is_nullable", "column_default"
      FROM "information_schema"."columns"
      WHERE "table_schema" = 'public'
        AND "table_name" = 'sandbox_environment_validations'
        AND "column_name" = 'resource_snapshot'
    `);
    assert.deepEqual(validationResourceColumn, {
      data_type: 'jsonb',
      is_nullable: 'YES',
      column_default: null,
    });
    const [validationResourceConstraint] = await prisma.$queryRawUnsafe(`
      SELECT pg_get_constraintdef(constraint_row."oid") AS definition
      FROM "pg_constraint" AS constraint_row
      JOIN "pg_class" AS relation
        ON relation."oid" = constraint_row."conrelid"
      JOIN "pg_namespace" AS namespace
        ON namespace."oid" = relation."relnamespace"
      WHERE namespace."nspname" = 'public'
        AND relation."relname" = 'sandbox_environment_validations'
        AND constraint_row."conname" =
          'sandbox_environment_validations_resource_snapshot_check'
    `);
    assert.match(validationResourceConstraint.definition, /diskSizeGb/);

    await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`
        INSERT INTO "users" ("id", "name", "allowed")
        VALUES ('fresh-admission-user', 'Fresh Admission User', true)
      `);
      await transaction.$executeRawUnsafe(`
        INSERT INTO "repos" ("id", "name", "git_source")
        VALUES (
          'fresh-admission-repo',
          'Fresh Admission Repo',
          'https://example.invalid/fresh-admission.git'
        )
      `);
      await transaction.$executeRawUnsafe(`
        INSERT INTO "tasks" ("id", "repo_id", "owner_user_id", "prompt")
        VALUES (
          'fresh-admission-task',
          'fresh-admission-repo',
          'fresh-admission-user',
          'fresh task and work committed together'
        )
      `);
      await transaction.$executeRawUnsafe(`
        INSERT INTO "task_admission_work" (
          "task_id", "updated_at", "resolved_branch", "resource_snapshot",
          "workspace_materialization_deadline_ms"
        ) VALUES (
          'fresh-admission-task',
          CURRENT_TIMESTAMP,
          'master',
          '{"diskSizeGb":64}'::jsonb,
          123456
        )
      `);
    });

    const [createdWork] = await prisma.$queryRawUnsafe(`
      SELECT count(*)::integer AS count,
             min("state") AS state,
             min("attempt") AS attempt,
             min("stage") AS stage,
             min("workspace_materialization_deadline_ms") AS deadline
      FROM "task_admission_work"
      WHERE "task_id" = 'fresh-admission-task'
    `);
    assert.deepEqual(createdWork, {
      count: 1,
      state: 'accepted',
      attempt: 0,
      stage: 'accepted',
      deadline: 123456,
    });

    await prisma.$executeRawUnsafe(`
      INSERT INTO "sandbox_environments" ("id", "name", "source")
      VALUES (
        'fresh-resource-environment',
        'Fresh Resource Environment',
        '{"kind":"boxlite-image","image":"example.invalid/cap:test"}'::jsonb
      )
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "sandbox_environment_validations" (
        "id", "environment_id", "status", "provider_family", "source_kind",
        "resource_snapshot"
      ) VALUES (
        'fresh-resource-validation',
        'fresh-resource-environment',
        'passed',
        'boxlite',
        'boxlite-image',
        '{"diskSizeGb":64}'::jsonb
      )
    `);
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        INSERT INTO "sandbox_environment_validations" (
          "id", "environment_id", "status", "provider_family", "source_kind",
          "resource_snapshot"
        ) VALUES (
          'invalid-resource-validation',
          'fresh-resource-environment',
          'failed',
          'boxlite',
          'boxlite-image',
          '{"diskSizeGb":64,"credential":"not-durable"}'::jsonb
        )
      `),
      'validation resource snapshots must reject unknown or secret-shaped keys',
    );

    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        INSERT INTO "task_admission_work" ("task_id", "updated_at")
        VALUES ('fresh-admission-task', CURRENT_TIMESTAMP)
      `),
      'a task must not have a second admission work row',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "task_admission_work"
        SET "state" = 'provider-native-cloning'
        WHERE "task_id" = 'fresh-admission-task'
      `),
      'provider-native states must not enter durable work',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "task_admission_work"
        SET "stage" = 'boxlite-native-clone'
        WHERE "task_id" = 'fresh-admission-task'
      `),
      'provider-native stages must not enter durable work',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "task_admission_work"
        SET "attempt" = -1
        WHERE "task_id" = 'fresh-admission-task'
      `),
      'attempt must be non-negative',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "task_admission_work"
        SET "lease_owner" = 'worker-without-expiry'
        WHERE "task_id" = 'fresh-admission-task'
      `),
      'lease owner and expiry must be present as a pair',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "task_admission_work"
        SET "state" = 'failed'
        WHERE "task_id" = 'fresh-admission-task'
      `),
      'failed work must atomically carry an allowlisted cause',
    );
    await prisma.$executeRawUnsafe(`
      UPDATE "task_admission_work"
      SET
        "state" = 'failed',
        "cause_code" = 'provisioning_workspace_timeout'
      WHERE "task_id" = 'fresh-admission-task'
    `);
    for (const causeCode of PROVISIONING_FAILURE_CODES) {
      await prisma.$executeRawUnsafe(
        `
          UPDATE "task_admission_work"
          SET "cause_code" = $1
          WHERE "task_id" = 'fresh-admission-task'
        `,
        causeCode,
      );
      const [persistedCause] = await prisma.$queryRawUnsafe(`
        SELECT "cause_code"
        FROM "task_admission_work"
        WHERE "task_id" = 'fresh-admission-task'
      `);
      assert.equal(persistedCause.cause_code, causeCode);
    }
    await prisma.$executeRawUnsafe(`
      UPDATE "task_admission_work"
      SET
        "state" = 'retrying',
        "cause_code" = 'provisioning_tls_network_failed'
      WHERE "task_id" = 'fresh-admission-task'
    `);
    await prisma.$executeRawUnsafe(`
      UPDATE "task_admission_work"
      SET "cause_code" = NULL
      WHERE "task_id" = 'fresh-admission-task'
    `);
    const [rollingRetry] = await prisma.$queryRawUnsafe(`
      SELECT "state", "cause_code"
      FROM "task_admission_work"
      WHERE "task_id" = 'fresh-admission-task'
    `);
    assert.deepEqual(
      rollingRetry,
      { state: 'retrying', cause_code: null },
      'rolling old writers may settle a retry without cause until convergence',
    );
    await prisma.$executeRawUnsafe(`
      UPDATE "task_admission_work"
      SET
        "state" = 'failed',
        "cause_code" = 'provisioning_unknown'
      WHERE "task_id" = 'fresh-admission-task'
    `);
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "task_admission_work"
        SET "cause_code" = 'git clone failed: authorization bearer canary'
        WHERE "task_id" = 'fresh-admission-task'
      `),
      'raw diagnostics must not be accepted as a durable cause',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "tasks"
        SET "lifecycle_version" = -1
        WHERE "id" = 'fresh-admission-task'
      `),
      'task lifecycle fence must be non-negative',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "task_admission_work"
        SET "resolved_branch" = 'main'
        WHERE "task_id" = 'fresh-admission-task'
      `),
      'resolved branch snapshot must be immutable',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "task_admission_work"
        SET "resource_snapshot" = '{"diskSizeGb":128}'::jsonb
        WHERE "task_id" = 'fresh-admission-task'
      `),
      'resource snapshot must be immutable',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "task_admission_work"
        SET "workspace_materialization_deadline_ms" = 234567
        WHERE "task_id" = 'fresh-admission-task'
      `),
      'workspace materialization deadline snapshot must be immutable',
    );

    await prisma.$executeRawUnsafe(`
      INSERT INTO "tasks" ("id", "repo_id", "owner_user_id", "prompt")
      VALUES (
        'legacy-null-deadline-task',
        'fresh-admission-repo',
        'fresh-admission-user',
        'rolling compatibility deadline probe'
      )
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "task_admission_work" ("task_id", "updated_at")
      VALUES ('legacy-null-deadline-task', CURRENT_TIMESTAMP)
    `);
    const [legacyDeadline] = await prisma.$queryRawUnsafe(`
      SELECT "workspace_materialization_deadline_ms" AS deadline
      FROM "task_admission_work"
      WHERE "task_id" = 'legacy-null-deadline-task'
    `);
    assert.deepEqual(legacyDeadline, { deadline: null });
    await prisma.$executeRawUnsafe(`
      UPDATE "task_admission_work"
      SET "workspace_materialization_deadline_ms" = 900000
      WHERE "task_id" = 'legacy-null-deadline-task'
    `);
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "task_admission_work"
        SET "workspace_materialization_deadline_ms" = 900001
        WHERE "task_id" = 'legacy-null-deadline-task'
      `),
      'a rolling null deadline may be filled once but is immutable afterward',
    );

    for (const failureCode of PROVISIONING_FAILURE_CODES) {
      await prisma.$executeRawUnsafe(
        `
          UPDATE "tasks"
          SET
            "status" = 'failed',
            "failure_code" = $1,
            "failure_at" = CURRENT_TIMESTAMP
          WHERE "id" = 'fresh-admission-task'
        `,
        failureCode,
      );
      const [persistedFailure] = await prisma.$queryRawUnsafe(`
        SELECT "failure_code"
        FROM "tasks"
        WHERE "id" = 'fresh-admission-task'
      `);
      assert.equal(persistedFailure.failure_code, failureCode);
    }
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "tasks"
        SET "failure_code" = 'provisioning_git_raw_diagnostic'
        WHERE "id" = 'fresh-admission-task'
      `),
      'task failure code must reject non-contract raw provisioning values',
    );

    await prisma.$executeRawUnsafe(`
      INSERT INTO "tasks" ("id", "repo_id", "owner_user_id", "prompt")
      VALUES (
        'invalid-resource-admission-task',
        'fresh-admission-repo',
        'fresh-admission-user',
        'resource constraint probe'
      )
    `);
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        INSERT INTO "task_admission_work" (
          "task_id", "updated_at", "resource_snapshot"
        ) VALUES (
          'invalid-resource-admission-task',
          CURRENT_TIMESTAMP,
          '{"diskSizeGb":64,"credential":"not-durable"}'::jsonb
        )
      `),
      'resource snapshots must reject non-contract and secret-shaped keys',
    );

    await prisma.$executeRawUnsafe(`
      INSERT INTO "tasks" ("id", "repo_id", "owner_user_id", "prompt")
      VALUES (
        'invalid-deadline-admission-task',
        'fresh-admission-repo',
        'fresh-admission-user',
        'deadline constraint probe'
      )
    `);
    for (const invalidDeadline of [999, 86400001]) {
      await expectConstraintFailure(
        prisma.$executeRawUnsafe(
          `
            INSERT INTO "task_admission_work" (
              "task_id", "updated_at",
              "workspace_materialization_deadline_ms"
            ) VALUES (
              'invalid-deadline-admission-task',
              CURRENT_TIMESTAMP,
              $1
            )
          `,
          invalidDeadline,
        ),
        'workspace materialization deadline must remain in the bounded policy range',
      );
    }

    await prisma.$executeRawUnsafe(`
      DELETE FROM "tasks" WHERE "id" = 'fresh-admission-task'
    `);
    const [cascadedWork] = await prisma.$queryRawUnsafe(`
      SELECT count(*)::integer AS count
      FROM "task_admission_work"
      WHERE "task_id" = 'fresh-admission-task'
    `);
    assert.equal(cascadedWork.count, 0, 'task deletion must cascade to work');
  } finally {
    await prisma.$disconnect();
  }
}

async function verifyProvisioningDiagnosticsFreshSchemaAndBehavior() {
  const prisma = client();
  try {
    const taskExpectationColumns = await prisma.$queryRawUnsafe(`
      SELECT "column_name", "data_type", "is_nullable", "column_default"
      FROM "information_schema"."columns"
      WHERE "table_schema" = 'public'
        AND "table_name" = 'tasks'
        AND "column_name" IN (
          'provisioning_diagnostic_schema_version',
          'provisioning_diagnostic_next_attempt'
        )
      ORDER BY "column_name"
    `);
    assert.deepEqual(taskExpectationColumns, [
      {
        column_name: 'provisioning_diagnostic_next_attempt',
        data_type: 'integer',
        is_nullable: 'YES',
        column_default: null,
      },
      {
        column_name: 'provisioning_diagnostic_schema_version',
        data_type: 'integer',
        is_nullable: 'YES',
        column_default: null,
      },
    ]);

    const diagnosticRelations = await prisma.$queryRawUnsafe(`
      SELECT "table_name"
      FROM "information_schema"."tables"
      WHERE "table_schema" = 'public'
        AND "table_name" IN (
          'task_provisioning_diagnostic_attempts',
          'task_provisioning_diagnostic_events',
          'task_provisioning_diagnostic_compactions'
        )
      ORDER BY "table_name"
    `);
    assert.deepEqual(
      diagnosticRelations.map(({ table_name }) => table_name),
      [
        'task_provisioning_diagnostic_attempts',
        'task_provisioning_diagnostic_compactions',
        'task_provisioning_diagnostic_events',
      ],
    );
    const diagnosticColumns = await prisma.$queryRawUnsafe(`
      SELECT "table_name", "column_name", "data_type"
      FROM "information_schema"."columns"
      WHERE "table_schema" = 'public'
        AND "table_name" LIKE 'task_provisioning_diagnostic_%'
      ORDER BY "table_name", "ordinal_position"
    `);
    assert.deepEqual(
      diagnosticColumns.filter(({ data_type }) =>
        ['json', 'jsonb'].includes(data_type),
      ),
      [],
      'diagnostic persistence must use fixed typed columns, not a JSON bag',
    );
    const forbiddenDiagnosticColumn =
      /(credential|secret|header|argv|body|endpoint|url|stdout|stderr|prompt|stack|raw|provider_(?:sandbox|resource|execution)_id)/i;
    assert.deepEqual(
      diagnosticColumns.filter(({ column_name }) =>
        forbiddenDiagnosticColumn.test(column_name),
      ),
      [],
      'diagnostic persistence must not add raw provider or secret-shaped columns',
    );

    const diagnosticTriggers = await prisma.$queryRawUnsafe(`
      SELECT trigger_row."tgname"
      FROM "pg_trigger" AS trigger_row
      JOIN "pg_class" AS relation
        ON relation."oid" = trigger_row."tgrelid"
      JOIN "pg_namespace" AS namespace
        ON namespace."oid" = relation."relnamespace"
      WHERE namespace."nspname" = 'public'
        AND NOT trigger_row."tgisinternal"
        AND trigger_row."tgname" LIKE 'task_provisioning_diagnostic_%'
      ORDER BY trigger_row."tgname"
    `);
    assert.deepEqual(
      diagnosticTriggers.map(({ tgname }) => tgname),
      [
        'task_provisioning_diagnostic_attempt_controlled_delete_trigger',
        'task_provisioning_diagnostic_attempt_monotonic_update_trigger',
        'task_provisioning_diagnostic_event_controlled_delete_trigger',
        'task_provisioning_diagnostic_event_immutable_trigger',
      ],
    );

    await prisma.$executeRawUnsafe(`
      INSERT INTO "users" ("id", "name", "allowed")
      VALUES ('diagnostics-user', 'Diagnostics User', true)
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "repos" ("id", "name", "git_source")
      VALUES (
        'diagnostics-repo',
        'Diagnostics Repo',
        'https://example.invalid/diagnostics.git'
      )
    `);

    await insertDiagnosticTask(prisma, 'new-diagnostics-task');
    assert.deepEqual(
      await readDiagnosticCoverageFixture(prisma, 'new-diagnostics-task'),
      {
        schema_version: 1,
        next_attempt: 1,
        attempt_count: 0,
        coverage: 'not_started',
      },
      'a newly written expectation is distinct from a historical task',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "tasks"
        SET "provisioning_diagnostic_next_attempt" = 0
        WHERE "id" = 'new-diagnostics-task'
      `),
      'a diagnostic next-attempt counter cannot move backwards',
    );

    await insertDiagnosticTask(prisma, 'missing-diagnostic-write-task', 2);
    assert.deepEqual(
      await readDiagnosticCoverageFixture(
        prisma,
        'missing-diagnostic-write-task',
      ),
      {
        schema_version: 1,
        next_attempt: 2,
        attempt_count: 0,
        coverage: 'partial',
      },
      'a consumed counter without its expected attempt is fail-closed partial',
    );

    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        INSERT INTO "tasks" (
          "id", "repo_id", "owner_user_id", "prompt",
          "provisioning_diagnostic_schema_version"
        ) VALUES (
          'unpaired-diagnostic-version-task',
          'diagnostics-repo',
          'diagnostics-user',
          'unpaired expectation must fail',
          1
        )
      `),
      'diagnostic expectation version and counter must be present as a pair',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        INSERT INTO "tasks" (
          "id", "repo_id", "owner_user_id", "prompt",
          "provisioning_diagnostic_schema_version",
          "provisioning_diagnostic_next_attempt"
        ) VALUES (
          'invalid-diagnostic-counter-task',
          'diagnostics-repo',
          'diagnostics-user',
          'invalid expectation counter must fail',
          1,
          0
        )
      `),
      'diagnostic next-attempt counter must remain positive',
    );

    await insertDiagnosticTask(prisma, 'diagnostic-compaction-task', 4);
    const oldestAttemptId = '11111111-1111-4111-8111-111111111111';
    const pendingAttemptId = '22222222-2222-4222-8222-222222222222';
    const activeAttemptId = '33333333-3333-4333-8333-333333333333';
    const oldestEventId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
    await insertTerminalDiagnosticAttempt(prisma, {
      id: oldestAttemptId,
      taskId: 'diagnostic-compaction-task',
      attemptNumber: 1,
      eventCount: 1,
    });
    await insertTerminalDiagnosticAttempt(prisma, {
      id: pendingAttemptId,
      taskId: 'diagnostic-compaction-task',
      attemptNumber: 2,
      cleanupState: 'pending',
    });
    await insertActiveDiagnosticAttempt(prisma, {
      id: activeAttemptId,
      taskId: 'diagnostic-compaction-task',
      attemptNumber: 3,
      providerFamily: 'unknown',
    });
    await insertTerminalDiagnosticEvent(prisma, {
      id: oldestEventId,
      attemptId: oldestAttemptId,
      taskId: 'diagnostic-compaction-task',
      sequence: 1,
      idempotencyKey: 'runtime-setup.terminal.attempt-1',
      operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
    });

    await expectConstraintFailure(
      prisma.$executeRawUnsafe(
        `
          UPDATE "task_provisioning_diagnostic_attempts"
          SET "schema_version" = 2
          WHERE "id" = $1
        `,
        oldestAttemptId,
      ),
      'attempt rows must reject unsupported schema versions',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(
        `
          UPDATE "task_provisioning_diagnostic_attempts"
          SET "attempt_number" = 0
          WHERE "id" = $1
        `,
        oldestAttemptId,
      ),
      'attempt rows must reject non-positive task-local numbering',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(
        `
          UPDATE "task_provisioning_diagnostic_attempts"
          SET "id" = 'provider-native-attempt-id'
          WHERE "id" = $1
        `,
        oldestAttemptId,
      ),
      'attempt identities must be CAP-generated UUIDs',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(
        `
          UPDATE "task_provisioning_diagnostic_attempts"
          SET "attempt_number" = 1
          WHERE "id" = $1
        `,
        pendingAttemptId,
      ),
      'attempt numbering must be unique within a task',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(
        `
          UPDATE "task_provisioning_diagnostic_attempts"
          SET "coverage" = 'complete',
              "completeness_marked_at" = CURRENT_TIMESTAMP
          WHERE "id" = $1
        `,
        pendingAttemptId,
      ),
      'cleanup-pending attempts cannot carry a completeness marker',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(
        `
          UPDATE "task_provisioning_diagnostic_attempts"
          SET "event_count" = 65
          WHERE "id" = $1
        `,
        oldestAttemptId,
      ),
      'attempt event counts must remain within the configured ceiling',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(
        `
          UPDATE "task_provisioning_diagnostic_attempts"
          SET "primary_cause" = 'unknown'
          WHERE "id" = $1
        `,
        oldestAttemptId,
      ),
      'a settled primary cause cannot be rewritten by cleanup or recovery',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(
        `
          UPDATE "task_provisioning_diagnostic_attempts"
          SET "cleanup_cause" = 'cleanup_failed'
          WHERE "id" = $1
        `,
        pendingAttemptId,
      ),
      'cleanup evidence cannot drift without advancing its physical attempt count',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(
        `
          UPDATE "task_provisioning_diagnostic_attempts"
          SET "state" = 'cancelled',
              "primary_outcome" = 'failed',
              "primary_retryable" = false,
              "primary_observed_at" = CURRENT_TIMESTAMP,
              "finished_at" = CURRENT_TIMESTAMP
          WHERE "id" = $1
        `,
        activeAttemptId,
      ),
      'attempt state and primary outcome must retain their closed semantic pairing',
    );

    await prisma.$executeRawUnsafe(
      `
        UPDATE "task_provisioning_diagnostic_attempts"
        SET "provider_family" = 'boxlite'
        WHERE "id" = $1
      `,
      activeAttemptId,
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(
        `
          UPDATE "task_provisioning_diagnostic_attempts"
          SET "provider_family" = 'aio'
          WHERE "id" = $1
        `,
        activeAttemptId,
      ),
      'provider family may converge from unknown once but is immutable after selection',
    );

    await expectConstraintFailure(
      insertTerminalDiagnosticEvent(prisma, {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
        attemptId: oldestAttemptId,
        taskId: 'diagnostic-compaction-task',
        sequence: 2,
        idempotencyKey: 'invalid.schema-version',
        operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
        schemaVersion: 2,
      }),
      'event rows must reject unsupported schema versions',
    );
    await expectConstraintFailure(
      insertTerminalDiagnosticEvent(prisma, {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
        attemptId: oldestAttemptId,
        taskId: 'diagnostic-compaction-task',
        sequence: 65,
        idempotencyKey: 'invalid.sequence',
        operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3',
      }),
      'event sequence must remain within the configured ceiling',
    );
    await expectConstraintFailure(
      insertTerminalDiagnosticEvent(prisma, {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6',
        attemptId: oldestAttemptId,
        taskId: 'diagnostic-compaction-task',
        sequence: 2,
        idempotencyKey: 'invalid.channel',
        operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb7',
        channel: 'provider-native',
      }),
      'event causal channel must remain in its closed vocabulary',
    );
    await expectConstraintFailure(
      insertTerminalDiagnosticEvent(prisma, {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7',
        attemptId: oldestAttemptId,
        taskId: 'diagnostic-compaction-task',
        sequence: 2,
        idempotencyKey: 'invalid.anomaly',
        operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb8',
        anomaly: 'raw-provider-prose',
      }),
      'event anomaly must remain in its closed vocabulary',
    );
    await expectConstraintFailure(
      insertTerminalDiagnosticEvent(prisma, {
        id: 'provider-native-event-id',
        attemptId: oldestAttemptId,
        taskId: 'diagnostic-compaction-task',
        sequence: 2,
        idempotencyKey: 'invalid.event-id',
        operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4',
      }),
      'event identities must be CAP-generated UUIDs',
    );
    await expectConstraintFailure(
      insertTerminalDiagnosticEvent(prisma, {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
        attemptId: oldestAttemptId,
        taskId: 'diagnostic-compaction-task',
        sequence: 2,
        idempotencyKey: 'runtime-setup.terminal.attempt-1',
        operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5',
      }),
      'event replay identities must be unique within an attempt',
    );
    await expectConstraintFailure(
      insertTerminalDiagnosticEvent(prisma, {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
        attemptId: oldestAttemptId,
        taskId: 'diagnostic-compaction-task',
        sequence: 1,
        idempotencyKey: 'duplicate.sequence',
        operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6',
      }),
      'event sequence must be unique within an attempt',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(
        `
          UPDATE "task_provisioning_diagnostic_events"
          SET "duration_ms" = 1201
          WHERE "id" = $1
        `,
        oldestEventId,
      ),
      'retained diagnostic events must be immutable',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(
        `DELETE FROM "task_provisioning_diagnostic_events" WHERE "id" = $1`,
        oldestEventId,
      ),
      'event detail cannot be deleted outside controlled compaction',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(
        `DELETE FROM "task_provisioning_diagnostic_attempts" WHERE "id" = $1`,
        oldestAttemptId,
      ),
      'attempt detail cannot be deleted outside controlled compaction',
    );

    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        INSERT INTO "task_provisioning_diagnostic_compactions" (
          "task_id", "compacted_attempt_from", "compacted_attempt_to",
          "compacted_attempt_count", "compacted_event_count",
          "truncation_count", "primary_failed_count",
          "cleanup_pending_count", "compacted_at", "updated_at"
        ) VALUES (
          'diagnostic-compaction-task', 1, 1, 1, 1, 1, 1, 1,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `),
      'compaction summaries cannot claim deletion of cleanup-pending detail',
    );
    const [detailBeforeCompaction] = await prisma.$queryRawUnsafe(
      `
        SELECT count(*)::integer AS count
        FROM "task_provisioning_diagnostic_attempts"
        WHERE "id" = $1
      `,
      oldestAttemptId,
    );
    assert.equal(
      detailBeforeCompaction.count,
      1,
      'failed summary persistence must leave old detail intact',
    );

    await prisma.$transaction(async (transaction) => {
      await insertDiagnosticCompaction(
        transaction,
        'diagnostic-compaction-task',
      );
      const [summaryBeforeDelete] = await transaction.$queryRawUnsafe(`
        SELECT "compacted_attempt_from", "compacted_attempt_to"
        FROM "task_provisioning_diagnostic_compactions"
        WHERE "task_id" = 'diagnostic-compaction-task'
      `);
      assert.deepEqual(summaryBeforeDelete, {
        compacted_attempt_from: 1,
        compacted_attempt_to: 1,
      });
      await transaction.$executeRawUnsafe(
        `SET LOCAL cap.diagnostic_compaction = 'on'`,
      );
      await transaction.$executeRawUnsafe(
        `DELETE FROM "task_provisioning_diagnostic_attempts" WHERE "id" = $1`,
        oldestAttemptId,
      );
    });

    const [compactionState] = await prisma.$queryRawUnsafe(`
      SELECT
        summary."compacted_attempt_from",
        summary."compacted_attempt_to",
        summary."compacted_attempt_count",
        summary."compacted_event_count",
        summary."truncation_count",
        summary."primary_failed_count",
        summary."cleanup_not_required_count",
        task."provisioning_diagnostic_next_attempt" AS next_attempt
      FROM "task_provisioning_diagnostic_compactions" AS summary
      JOIN "tasks" AS task ON task."id" = summary."task_id"
      WHERE summary."task_id" = 'diagnostic-compaction-task'
    `);
    assert.deepEqual(compactionState, {
      compacted_attempt_from: 1,
      compacted_attempt_to: 1,
      compacted_attempt_count: 1,
      compacted_event_count: 1,
      truncation_count: 1,
      primary_failed_count: 1,
      cleanup_not_required_count: 1,
      next_attempt: 4,
    });
    const retainedAttempts = await prisma.$queryRawUnsafe(`
      SELECT "attempt_number", "state", "cleanup_state"
      FROM "task_provisioning_diagnostic_attempts"
      WHERE "task_id" = 'diagnostic-compaction-task'
      ORDER BY "attempt_number"
    `);
    assert.deepEqual(retainedAttempts, [
      { attempt_number: 2, state: 'failed', cleanup_state: 'pending' },
      { attempt_number: 3, state: 'active', cleanup_state: 'not_required' },
    ]);
    const [compactedEvent] = await prisma.$queryRawUnsafe(
      `
        SELECT count(*)::integer AS count
        FROM "task_provisioning_diagnostic_events"
        WHERE "id" = $1
      `,
      oldestEventId,
    );
    assert.equal(compactedEvent.count, 0);

    await insertDiagnosticTask(prisma, 'cleanup-null-evidence-task');
    const insertIncompleteCleanupEvidence = (client) =>
      client.$executeRawUnsafe(`
        INSERT INTO "sandbox_runs" (
          "id", "task_id", "provider_id", "provider_sandbox_id",
          "create_state", "status", "cleanup_attempt_count",
          "cleanup_last_observed_at", "updated_at"
        ) VALUES (
          'cleanup-null-evidence-run',
          'cleanup-null-evidence-task',
          'boxlite',
          'internal-null-provider-owner',
          'idle',
          'deleting',
          1,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )
      `);
    await expectConstraintFailure(
      insertIncompleteCleanupEvidence(prisma),
      'counted cleanup evidence requires every discriminant to be explicitly valid',
    );
    await expectConstraintFailure(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`
          ALTER TABLE "sandbox_runs"
          DROP CONSTRAINT "sandbox_runs_cleanup_evidence_check"
        `);
        await insertIncompleteCleanupEvidence(tx);
        await tx.$executeRawUnsafe(`
          UPDATE "sandbox_runs"
          SET "status" = 'removed'
          WHERE "id" = 'cleanup-null-evidence-run'
        `);
      }),
      'incomplete legacy evidence cannot bypass cleanup completion through SQL NULL semantics',
    );

    await insertDiagnosticTask(prisma, 'cleanup-evidence-task');
    await prisma.$executeRawUnsafe(`
      INSERT INTO "sandbox_runs" (
        "id", "task_id", "provider_id", "provider_sandbox_id",
        "owner_generation", "resource_generation", "create_state", "status",
        "cleanup_attempt_in_flight", "cleanup_attempt_count",
        "cleanup_last_attempt_id", "cleanup_last_outcome",
        "cleanup_last_proof", "cleanup_last_cause",
        "cleanup_last_retryable", "cleanup_last_observed_at", "updated_at"
      ) VALUES (
        'cleanup-evidence-run',
        'cleanup-evidence-task',
        'boxlite',
        'internal-provider-owner',
        'cleanup-owner-g1',
        'cleanup-resource-r1',
        'entered',
        'deleting',
        FALSE,
        1,
        '11111111-1111-4111-8111-111111111111',
        'failed',
        NULL,
        'cleanup_failed',
        FALSE,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
    `);
    const [cleanupEvidence] = await prisma.$queryRawUnsafe(`
      SELECT "status", "cleanup_attempt_in_flight", "cleanup_attempt_count",
             "cleanup_last_attempt_id", "cleanup_last_outcome",
             "cleanup_last_proof", "cleanup_last_cause",
             "cleanup_last_retryable"
      FROM "sandbox_runs"
      WHERE "id" = 'cleanup-evidence-run'
    `);
    assert.deepEqual(cleanupEvidence, {
      status: 'deleting',
      cleanup_attempt_in_flight: false,
      cleanup_attempt_count: 1,
      cleanup_last_attempt_id: '11111111-1111-4111-8111-111111111111',
      cleanup_last_outcome: 'failed',
      cleanup_last_proof: null,
      cleanup_last_cause: 'cleanup_failed',
      cleanup_last_retryable: false,
    });
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "sandbox_runs"
        SET "status" = 'removed'
        WHERE "id" = 'cleanup-evidence-run'
      `),
      'durable cleanup cannot complete without settled success proof',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "sandbox_runs"
        SET "cleanup_attempt_count" = 3,
            "cleanup_attempt_in_flight" = TRUE,
            "cleanup_last_attempt_id" = '33333333-3333-4333-8333-333333333333',
            "cleanup_last_outcome" = 'indeterminate',
            "cleanup_last_proof" = NULL,
            "cleanup_last_cause" = 'cleanup_unconfirmed',
            "cleanup_last_retryable" = TRUE,
            "cleanup_last_observed_at" = CURRENT_TIMESTAMP
        WHERE "id" = 'cleanup-evidence-run'
      `),
      'cleanup allocator cannot jump attempt numbers',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "sandbox_runs"
        SET "cleanup_attempt_count" = 2,
            "cleanup_attempt_in_flight" = FALSE,
            "cleanup_last_attempt_id" = '22222222-2222-4222-8222-222222222222',
            "cleanup_last_outcome" = 'indeterminate',
            "cleanup_last_proof" = NULL,
            "cleanup_last_cause" = 'cleanup_unconfirmed',
            "cleanup_last_retryable" = TRUE,
            "cleanup_last_observed_at" = CURRENT_TIMESTAMP
        WHERE "id" = 'cleanup-evidence-run'
      `),
      'cleanup allocator must make the new placeholder in flight',
    );
    await prisma.$executeRawUnsafe(`
      UPDATE "sandbox_runs"
      SET "cleanup_attempt_count" = 2,
          "cleanup_attempt_in_flight" = TRUE,
          "cleanup_last_attempt_id" = '22222222-2222-4222-8222-222222222222',
          "cleanup_last_outcome" = 'indeterminate',
          "cleanup_last_proof" = NULL,
          "cleanup_last_cause" = 'cleanup_unconfirmed',
          "cleanup_last_retryable" = TRUE,
          "cleanup_last_observed_at" = CURRENT_TIMESTAMP
      WHERE "id" = 'cleanup-evidence-run'
    `);
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "sandbox_runs"
        SET "cleanup_attempt_count" = 3,
            "cleanup_last_attempt_id" = '33333333-3333-4333-8333-333333333333',
            "cleanup_last_observed_at" = CURRENT_TIMESTAMP
        WHERE "id" = 'cleanup-evidence-run'
      `),
      'an in-flight cleanup attempt blocks a second allocator',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "sandbox_runs"
        SET "resource_generation" = 'cleanup-resource-r2'
        WHERE "id" = 'cleanup-evidence-run'
      `),
      'a deleting cleanup authority freezes the physical resource generation',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "sandbox_runs"
        SET "owner_generation" = 'cleanup-owner-g2'
        WHERE "id" = 'cleanup-evidence-run'
      `),
      'cleanup takeover cannot transfer ownership while leaving inherited work in flight',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "sandbox_runs"
        SET "cleanup_attempt_in_flight" = FALSE,
            "cleanup_last_outcome" = 'failed',
            "cleanup_last_cause" = 'cleanup_unconfirmed',
            "cleanup_last_retryable" = FALSE,
            "cleanup_last_observed_at" = CURRENT_TIMESTAMP
        WHERE "id" = 'cleanup-evidence-run'
      `),
      'failed cleanup evidence requires cleanup_failed',
    );
    await prisma.$executeRawUnsafe(`
      UPDATE "sandbox_runs"
      SET "cleanup_attempt_in_flight" = FALSE,
          "cleanup_last_outcome" = 'failed',
          "cleanup_last_proof" = NULL,
          "cleanup_last_cause" = 'cleanup_failed',
          "cleanup_last_retryable" = TRUE,
          "cleanup_last_observed_at" = CURRENT_TIMESTAMP
      WHERE "id" = 'cleanup-evidence-run'
    `);
    await prisma.$executeRawUnsafe(`
      UPDATE "sandbox_runs"
      SET "cleanup_attempt_in_flight" = FALSE,
          "cleanup_last_outcome" = 'failed',
          "cleanup_last_proof" = NULL,
          "cleanup_last_cause" = 'cleanup_failed',
          "cleanup_last_retryable" = TRUE
      WHERE "id" = 'cleanup-evidence-run'
    `);
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "sandbox_runs"
        SET "cleanup_last_outcome" = 'indeterminate',
            "cleanup_last_cause" = 'cleanup_unconfirmed',
            "cleanup_last_retryable" = TRUE
        WHERE "id" = 'cleanup-evidence-run'
      `),
      'settled cleanup evidence cannot be rewritten at the same attempt',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "sandbox_runs"
        SET "cleanup_attempt_in_flight" = TRUE
        WHERE "id" = 'cleanup-evidence-run'
      `),
      'a settled attempt cannot be reopened',
    );
    await prisma.$executeRawUnsafe(`
      UPDATE "sandbox_runs"
      SET "cleanup_attempt_count" = 3,
          "cleanup_attempt_in_flight" = TRUE,
          "cleanup_last_attempt_id" = '33333333-3333-4333-8333-333333333333',
          "cleanup_last_outcome" = 'indeterminate',
          "cleanup_last_proof" = NULL,
          "cleanup_last_cause" = 'cleanup_unconfirmed',
          "cleanup_last_retryable" = TRUE,
          "cleanup_last_observed_at" = CURRENT_TIMESTAMP
      WHERE "id" = 'cleanup-evidence-run'
    `);
    await prisma.$executeRawUnsafe(`
      UPDATE "sandbox_runs"
      SET "owner_generation" = 'cleanup-owner-g2',
          "cleanup_attempt_in_flight" = FALSE
      WHERE "id" = 'cleanup-evidence-run'
    `);
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "sandbox_runs"
        SET "cleanup_last_outcome" = 'succeeded',
            "cleanup_last_proof" = 'already-absent',
            "cleanup_last_cause" = NULL,
            "cleanup_last_retryable" = FALSE
        WHERE "id" = 'cleanup-evidence-run'
      `),
      'a late result cannot replace takeover-settled indeterminate evidence',
    );
    await prisma.$executeRawUnsafe(`
      UPDATE "sandbox_runs"
      SET "cleanup_attempt_count" = 4,
          "cleanup_attempt_in_flight" = TRUE,
          "cleanup_last_attempt_id" = '44444444-4444-4444-8444-444444444444',
          "cleanup_last_outcome" = 'indeterminate',
          "cleanup_last_proof" = NULL,
          "cleanup_last_cause" = 'cleanup_unconfirmed',
          "cleanup_last_retryable" = TRUE,
          "cleanup_last_observed_at" = CURRENT_TIMESTAMP
      WHERE "id" = 'cleanup-evidence-run'
    `);
    await prisma.$executeRawUnsafe(`
      UPDATE "sandbox_runs"
      SET "create_state" = 'entered'
      WHERE "id" = 'cleanup-evidence-run'
    `);
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "sandbox_runs"
        SET "cleanup_attempt_in_flight" = FALSE,
            "cleanup_last_outcome" = 'succeeded',
            "cleanup_last_proof" = 'already-absent',
            "cleanup_last_cause" = NULL,
            "cleanup_last_retryable" = FALSE,
            "cleanup_last_observed_at" = CURRENT_TIMESTAMP
        WHERE "id" = 'cleanup-evidence-run'
      `),
      'cleanup cannot persist success proof while create may still return',
    );
    await prisma.$executeRawUnsafe(`
      UPDATE "sandbox_runs"
      SET "cleanup_attempt_in_flight" = FALSE,
          "cleanup_last_outcome" = 'indeterminate',
          "cleanup_last_proof" = NULL,
          "cleanup_last_cause" = 'cleanup_unconfirmed',
          "cleanup_last_retryable" = TRUE,
          "cleanup_last_observed_at" = CURRENT_TIMESTAMP
      WHERE "id" = 'cleanup-evidence-run'
    `);
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "sandbox_runs"
        SET "status" = 'removed'
        WHERE "id" = 'cleanup-evidence-run'
      `),
      'indeterminate cleanup cannot close authority after an unresolved create',
    );
    await prisma.$executeRawUnsafe(`
      UPDATE "sandbox_runs"
      SET "create_state" = 'idle'
      WHERE "id" = 'cleanup-evidence-run'
    `);
    await prisma.$executeRawUnsafe(`
      UPDATE "sandbox_runs"
      SET "cleanup_attempt_count" = 5,
          "cleanup_attempt_in_flight" = TRUE,
          "cleanup_last_attempt_id" = '55555555-5555-4555-8555-555555555555',
          "cleanup_last_outcome" = 'indeterminate',
          "cleanup_last_proof" = NULL,
          "cleanup_last_cause" = 'cleanup_unconfirmed',
          "cleanup_last_retryable" = TRUE,
          "cleanup_last_observed_at" = CURRENT_TIMESTAMP
      WHERE "id" = 'cleanup-evidence-run'
    `);
    await prisma.$executeRawUnsafe(`
      UPDATE "sandbox_runs"
      SET "cleanup_attempt_in_flight" = FALSE,
          "cleanup_last_outcome" = 'succeeded',
          "cleanup_last_proof" = 'already-absent',
          "cleanup_last_cause" = NULL,
          "cleanup_last_retryable" = FALSE,
          "cleanup_last_observed_at" = CURRENT_TIMESTAMP
      WHERE "id" = 'cleanup-evidence-run'
    `);
    await prisma.$executeRawUnsafe(`
      UPDATE "sandbox_runs"
      SET "status" = 'removed'
      WHERE "id" = 'cleanup-evidence-run'
    `);
    const [completedCleanup] = await prisma.$queryRawUnsafe(`
      SELECT "status", "cleanup_attempt_count", "cleanup_last_outcome",
             "cleanup_last_proof", "cleanup_attempt_in_flight"
      FROM "sandbox_runs"
      WHERE "id" = 'cleanup-evidence-run'
    `);
    assert.deepEqual(completedCleanup, {
      status: 'removed',
      cleanup_attempt_count: 5,
      cleanup_last_outcome: 'succeeded',
      cleanup_last_proof: 'already-absent',
      cleanup_attempt_in_flight: false,
    });

    await insertDiagnosticTask(prisma, 'cleanup-unproven-failed-task');
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        INSERT INTO "sandbox_runs" (
          "id", "task_id", "provider_id", "provider_sandbox_id",
          "owner_generation", "resource_generation", "create_state", "status",
          "updated_at"
        ) VALUES (
          'cleanup-unproven-failed-run',
          'cleanup-unproven-failed-task',
          'boxlite',
          'internal-unproven-failed-owner',
          'cleanup-unproven-owner-g1',
          'cleanup-unproven-resource-r1',
          'idle',
          'failed',
          CURRENT_TIMESTAMP
        )
      `),
      'failed cleanup authority requires post-migration terminal-policy evidence',
    );

    await insertDiagnosticTask(prisma, 'cleanup-forged-failed-task');
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        INSERT INTO "sandbox_runs" (
          "id", "task_id", "provider_id", "provider_sandbox_id",
          "owner_generation", "resource_generation", "create_state", "status",
          "cleanup_attempt_in_flight", "cleanup_attempt_count",
          "cleanup_last_attempt_id", "cleanup_last_outcome",
          "cleanup_last_proof", "cleanup_last_cause",
          "cleanup_last_retryable", "cleanup_last_observed_at", "updated_at"
        ) VALUES (
          'cleanup-forged-failed-run',
          'cleanup-forged-failed-task',
          'boxlite',
          'internal-forged-failed-owner',
          'cleanup-forged-owner-g1',
          'cleanup-forged-resource-r1',
          'idle',
          'failed',
          FALSE,
          1,
          '88888888-8888-4888-8888-888888888888',
          'indeterminate',
          NULL,
          'cleanup_unconfirmed',
          TRUE,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )
      `),
      'structurally valid evidence cannot forge failed authority by direct insert',
    );
    const [forgedFailedRun] = await prisma.$queryRawUnsafe(`
      SELECT count(*)::integer AS count
      FROM "sandbox_runs"
      WHERE "id" = 'cleanup-forged-failed-run'
    `);
    assert.equal(forgedFailedRun.count, 0);

    await insertDiagnosticTask(prisma, 'cleanup-terminal-policy-task');
    await prisma.$executeRawUnsafe(`
      INSERT INTO "sandbox_runs" (
        "id", "task_id", "provider_id", "provider_sandbox_id",
        "owner_generation", "resource_generation", "create_state", "status",
        "cleanup_attempt_in_flight", "cleanup_attempt_count",
        "cleanup_last_attempt_id", "cleanup_last_outcome",
        "cleanup_last_proof", "cleanup_last_cause",
        "cleanup_last_retryable", "cleanup_last_observed_at", "updated_at"
      ) VALUES (
        'cleanup-terminal-policy-run',
        'cleanup-terminal-policy-task',
        'boxlite',
        'internal-terminal-policy-owner',
        'cleanup-terminal-policy-owner-g1',
        'cleanup-terminal-policy-resource-r1',
        'entered',
        'deleting',
        FALSE,
        1,
        '66666666-6666-4666-8666-666666666666',
        'indeterminate',
        NULL,
        'cleanup_unconfirmed',
        TRUE,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
    `);
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "sandbox_runs"
        SET "status" = 'failed'
        WHERE "id" = 'cleanup-terminal-policy-run'
      `),
      'deleting cleanup cannot become failed without the dedicated terminal policy',
    );
    await expectConstraintFailure(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL cap.sandbox_cleanup_terminal_policy = 'on'`,
        );
        await tx.$executeRawUnsafe(`
          UPDATE "sandbox_runs"
          SET "status" = 'failed'
          WHERE "id" = 'cleanup-terminal-policy-run'
        `);
      }),
      'terminal policy cannot relinquish authority while create may still return',
    );
    await prisma.$executeRawUnsafe(`
      UPDATE "sandbox_runs"
      SET "create_state" = 'idle'
      WHERE "id" = 'cleanup-terminal-policy-run'
    `);
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "sandbox_runs"
        SET "cleanup_orphan_confirmed_at" = CURRENT_TIMESTAMP
        WHERE "id" = 'cleanup-terminal-policy-run'
      `),
      'orphan presence evidence requires the dedicated fresh-inventory seam',
    );
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SET LOCAL cap.sandbox_cleanup_orphan_confirmation = 'on'`,
      );
      await tx.$executeRawUnsafe(`
        UPDATE "sandbox_runs"
        SET "cleanup_orphan_confirmed_at" = CURRENT_TIMESTAMP
        WHERE "id" = 'cleanup-terminal-policy-run'
      `);
    });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SET LOCAL cap.sandbox_cleanup_terminal_policy = 'on'`,
      );
      await tx.$executeRawUnsafe(`
        UPDATE "sandbox_runs"
        SET "status" = 'failed'
        WHERE "id" = 'cleanup-terminal-policy-run'
      `);
    });
    const [terminalPolicyCleanup] = await prisma.$queryRawUnsafe(`
      SELECT "status", "owner_generation", "resource_generation",
             "cleanup_attempt_count", "cleanup_last_outcome",
             "cleanup_orphan_confirmed_at"
      FROM "sandbox_runs"
      WHERE "id" = 'cleanup-terminal-policy-run'
    `);
    assert(terminalPolicyCleanup.cleanup_orphan_confirmed_at instanceof Date);
    assert.deepEqual({
      ...terminalPolicyCleanup,
      cleanup_orphan_confirmed_at: 'confirmed',
    }, {
      status: 'failed',
      owner_generation: 'cleanup-terminal-policy-owner-g1',
      resource_generation: 'cleanup-terminal-policy-resource-r1',
      cleanup_attempt_count: 1,
      cleanup_last_outcome: 'indeterminate',
      cleanup_orphan_confirmed_at: 'confirmed',
    });
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "sandbox_runs"
        SET "status" = 'running'
        WHERE "id" = 'cleanup-terminal-policy-run'
      `),
      'terminal-policy cleanup cannot be reactivated',
    );
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(`
        UPDATE "sandbox_runs"
        SET "owner_generation" = 'cleanup-terminal-policy-owner-g2'
        WHERE "id" = 'cleanup-terminal-policy-run'
      `),
      'terminal-policy cleanup retains its exact settled generation',
    );

    await insertDiagnosticTask(prisma, 'cleanup-legacy-policy-task');
    await prisma.$executeRawUnsafe(`
      INSERT INTO "sandbox_runs" (
        "id", "task_id", "provider_id", "provider_sandbox_id",
        "owner_generation", "resource_generation", "create_state", "status",
        "updated_at"
      ) VALUES (
        'cleanup-legacy-policy-run',
        'cleanup-legacy-policy-task',
        'aio',
        'internal-legacy-policy-owner',
        NULL,
        NULL,
        'idle',
        'running',
        CURRENT_TIMESTAMP
      )
    `);
    const settleLegacyCleanupSql = `
      UPDATE "sandbox_runs"
      SET "status" = 'terminal',
          "cleanup_attempt_count" = 1,
          "cleanup_attempt_in_flight" = FALSE,
          "cleanup_last_attempt_id" = '77777777-7777-4777-8777-777777777777',
          "cleanup_last_outcome" = 'failed',
          "cleanup_last_proof" = NULL,
          "cleanup_last_cause" = 'cleanup_failed',
          "cleanup_last_retryable" = FALSE,
          "cleanup_last_observed_at" = CURRENT_TIMESTAMP
      WHERE "id" = 'cleanup-legacy-policy-run'
    `;
    await expectConstraintFailure(
      prisma.$executeRawUnsafe(settleLegacyCleanupSql),
      'legacy cleanup cannot bypass its bounded atomic settlement',
    );
    await expectConstraintFailure(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL cap.sandbox_cleanup_legacy_settlement = 'on'`,
        );
        await tx.$executeRawUnsafe(
          settleLegacyCleanupSql.replace(
            `SET "status" = 'terminal'`,
            `SET "status" = 'failed'`,
          ),
        );
      }),
      'legacy physical failure cannot become failed cleanup authority',
    );
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SET LOCAL cap.sandbox_cleanup_legacy_settlement = 'on'`,
      );
      await tx.$executeRawUnsafe(settleLegacyCleanupSql);
    });
    const [legacyPolicyCleanup] = await prisma.$queryRawUnsafe(`
      SELECT "status", "cleanup_attempt_count", "cleanup_last_outcome",
             "cleanup_attempt_in_flight"
      FROM "sandbox_runs"
      WHERE "id" = 'cleanup-legacy-policy-run'
    `);
    assert.deepEqual(legacyPolicyCleanup, {
      status: 'terminal',
      cleanup_attempt_count: 1,
      cleanup_last_outcome: 'failed',
      cleanup_attempt_in_flight: false,
    });

    await insertDiagnosticTask(prisma, 'cleanup-legacy-retain-success-task');
    await prisma.$executeRawUnsafe(`
      INSERT INTO "sandbox_runs" (
        "id", "task_id", "provider_id", "provider_sandbox_id",
        "owner_generation", "resource_generation", "create_state", "status",
        "updated_at"
      ) VALUES (
        'cleanup-legacy-retain-success-run',
        'cleanup-legacy-retain-success-task',
        'aio',
        'internal-legacy-retain-success-owner',
        NULL,
        NULL,
        'idle',
        'running',
        CURRENT_TIMESTAMP
      )
    `);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SET LOCAL cap.sandbox_cleanup_legacy_settlement = 'on'`,
      );
      await tx.$executeRawUnsafe(`
        UPDATE "sandbox_runs"
        SET "status" = 'terminal',
            "cleanup_attempt_count" = 1,
            "cleanup_attempt_in_flight" = FALSE,
            "cleanup_last_attempt_id" = '88888888-8888-4888-8888-888888888888',
            "cleanup_last_outcome" = 'succeeded',
            "cleanup_last_proof" = 'found-and-cleaned',
            "cleanup_last_cause" = NULL,
            "cleanup_last_retryable" = FALSE,
            "cleanup_last_observed_at" = CURRENT_TIMESTAMP
        WHERE "id" = 'cleanup-legacy-retain-success-run'
      `);
    });
    const [legacyRetainedSuccess] = await prisma.$queryRawUnsafe(`
      SELECT "status", "cleanup_last_outcome", "cleanup_last_proof"
      FROM "sandbox_runs"
      WHERE "id" = 'cleanup-legacy-retain-success-run'
    `);
    assert.deepEqual(legacyRetainedSuccess, {
      status: 'terminal',
      cleanup_last_outcome: 'succeeded',
      cleanup_last_proof: 'found-and-cleaned',
    });

    await insertDiagnosticTask(prisma, 'diagnostic-task-delete', 3);
    const deleteAttemptId = '44444444-4444-4444-8444-444444444444';
    await insertTerminalDiagnosticAttempt(prisma, {
      id: deleteAttemptId,
      taskId: 'diagnostic-task-delete',
      attemptNumber: 2,
      eventCount: 1,
    });
    await insertTerminalDiagnosticEvent(prisma, {
      id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
      attemptId: deleteAttemptId,
      taskId: 'diagnostic-task-delete',
      sequence: 1,
      idempotencyKey: 'task-delete.terminal',
      operationId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
    });
    await insertDiagnosticCompaction(prisma, 'diagnostic-task-delete');
    await prisma.$executeRawUnsafe(`
      DELETE FROM "tasks" WHERE "id" = 'diagnostic-task-delete'
    `);
    const [taskDeleteCounts] = await prisma.$queryRawUnsafe(`
      SELECT
        (SELECT count(*)::integer
         FROM "task_provisioning_diagnostic_attempts"
         WHERE "task_id" = 'diagnostic-task-delete') AS attempts,
        (SELECT count(*)::integer
         FROM "task_provisioning_diagnostic_events"
         WHERE "task_id" = 'diagnostic-task-delete') AS events,
        (SELECT count(*)::integer
         FROM "task_provisioning_diagnostic_compactions"
         WHERE "task_id" = 'diagnostic-task-delete') AS compactions
    `);
    assert.deepEqual(taskDeleteCounts, {
      attempts: 0,
      events: 0,
      compactions: 0,
    });

    await insertDiagnosticTask(prisma, 'rollback-compatible-task', 2);
    await prisma.$executeRawUnsafe(`
      UPDATE "tasks"
      SET "status" = 'failed',
          "failure_code" = 'provisioning_unknown',
          "failure_at" = CURRENT_TIMESTAMP
      WHERE "id" = 'rollback-compatible-task'
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "audit_events" (
        "id", "task_id", "user_id", "type", "level", "title", "description"
      ) VALUES (
        'rollback-compatible-audit',
        'rollback-compatible-task',
        'diagnostics-user',
        'task.failed',
        'error',
        'Task failed',
        'Stable lifecycle audit prose'
      )
    `);
    await insertTerminalDiagnosticAttempt(prisma, {
      id: '55555555-5555-4555-8555-555555555555',
      taskId: 'rollback-compatible-task',
      attemptNumber: 1,
    });
    const [ordinaryTaskAfterRollback] = await prisma.$queryRawUnsafe(`
      SELECT "id", "status", "failure_code"
      FROM "tasks"
      WHERE "id" = 'rollback-compatible-task'
    `);
    assert.deepEqual(ordinaryTaskAfterRollback, {
      id: 'rollback-compatible-task',
      status: 'failed',
      failure_code: 'provisioning_unknown',
    });
    const [auditAfterRollback] = await prisma.$queryRawUnsafe(`
      SELECT "type", "level", "title", "description"
      FROM "audit_events"
      WHERE "id" = 'rollback-compatible-audit'
    `);
    assert.deepEqual(auditAfterRollback, {
      type: 'task.failed',
      level: 'error',
      title: 'Task failed',
      description: 'Stable lifecycle audit prose',
    });
    assert.doesNotMatch(
      JSON.stringify({ ordinaryTaskAfterRollback, auditAfterRollback }),
      /command_failed|runtime_setup|boxlite/,
      'rollback-compatible Task and audit reads must not copy diagnostic detail',
    );
    const [retainedRollbackDiagnostic] = await prisma.$queryRawUnsafe(`
      SELECT count(*)::integer AS count
      FROM "task_provisioning_diagnostic_attempts"
      WHERE "task_id" = 'rollback-compatible-task'
        AND "primary_cause" = 'command_failed'
    `);
    assert.equal(
      retainedRollbackDiagnostic.count,
      1,
      'emergency application rollback leaves additive diagnostic evidence in place',
    );
    assert.deepEqual(
      readdirSync(
        path.join(sourceMigrationsDir, PROVISIONING_DIAGNOSTICS_MIGRATION),
      ).sort(),
      ['migration.sql'],
      'emergency rollback must not ship a destructive down migration',
    );
  } finally {
    await prisma.$disconnect();
  }
}

try {
  preparePreResourceMigrationFixture();
  preparePreDeadlineMigrationFixture();
  preparePreLegacyAioIdentityMigrationFixture();
  preparePrePlatformDependencyMigrationFixture();
  preparePreProvisioningDiagnosticsMigrationFixture();

  await resetPublicSchema();
  migrate(path.join(oldPrismaDir, 'schema.prisma'));
  await seedHistoricalRows();
  migrate(path.join(sourcePrismaDir, 'schema.prisma'));
  await verifyHistoricalUpgrade();

  await resetPublicSchema();
  migrate(path.join(preDeadlinePrismaDir, 'schema.prisma'));
  await seedPreDeadlineAdmissionWork();
  migrate(path.join(sourcePrismaDir, 'schema.prisma'));
  await verifyPreDeadlineAdmissionWorkUpgrade();

  await resetPublicSchema();
  migrate(path.join(preLegacyAioIdentityPrismaDir, 'schema.prisma'));
  await seedLegacyAioIdentityRows();
  migrate(path.join(sourcePrismaDir, 'schema.prisma'));
  await verifyLegacyAioIdentityUpgrade();

  await resetPublicSchema();
  migrate(path.join(prePlatformDependencyPrismaDir, 'schema.prisma'));
  await seedPrePlatformDependencyFailureRows();
  migrate(path.join(sourcePrismaDir, 'schema.prisma'));
  await verifyPlatformDependencyFailureUpgradeAndRollback();

  await resetPublicSchema();
  migrate(path.join(preProvisioningDiagnosticsPrismaDir, 'schema.prisma'));
  await seedPreProvisioningDiagnosticsRows();
  migrate(path.join(sourcePrismaDir, 'schema.prisma'));
  await verifyProvisioningDiagnosticsUpgradeCompatibility();

  await resetPublicSchema();
  migrate(path.join(sourcePrismaDir, 'schema.prisma'));
  await verifyFreshSchemaAndBehavior();
  await verifyProvisioningDiagnosticsFreshSchemaAndBehavior();

  console.log(
    'task-admission migration: historical null compatibility, pre-deadline ' +
      'rolling upgrade, legacy AIO readoption identity normalization, platform ' +
      'dependency compatibility, provisioning diagnostics fresh/upgrade/' +
      'rollback compatibility, honest unavailable/partial evidence, controlled ' +
      'compaction, exact constraints, and task-owned cascades passed',
  );
} finally {
  await resetPublicSchema();
  rmSync(tempRoot, { recursive: true, force: true });
}
