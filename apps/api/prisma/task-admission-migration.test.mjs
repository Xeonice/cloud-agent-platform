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
const PROVISIONING_FAILURE_CODES = [
  'provisioning_capacity_exhausted',
  'provisioning_workspace_timeout',
  'provisioning_forge_auth_failed',
  'provisioning_tls_network_failed',
  'provisioning_ref_not_found',
  'provisioning_unknown',
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

const tempRoot = mkdtempSync(path.join(tmpdir(), 'cap-task-admission-migration-'));
const oldPrismaDir = path.join(tempRoot, 'prisma');
const oldMigrationsDir = path.join(oldPrismaDir, 'migrations');
const preDeadlinePrismaDir = path.join(tempRoot, 'pre-deadline-prisma');
const preDeadlineMigrationsDir = path.join(
  preDeadlinePrismaDir,
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
          status: 'deleting',
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
      'upgrade must retain NULL generations and conservatively classify in-flight creates',
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

try {
  preparePreResourceMigrationFixture();
  preparePreDeadlineMigrationFixture();

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
  migrate(path.join(sourcePrismaDir, 'schema.prisma'));
  await verifyFreshSchemaAndBehavior();

  console.log(
    'task-admission migration: historical null compatibility, pre-deadline ' +
      'rolling upgrade, exact fresh schema, constraints, one-work uniqueness, ' +
      'and cascade passed',
  );
} finally {
  await resetPublicSchema();
  rmSync(tempRoot, { recursive: true, force: true });
}
