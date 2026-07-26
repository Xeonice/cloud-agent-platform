import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const migrationSql = readFileSync(
  resolve(
    __dirname,
    '../../prisma/migrations/20260710170000_add_sandbox_toolchain_metadata/migration.sql',
  ),
  'utf8',
);

const terminalBridgeContractMigrationSql = readFileSync(
  resolve(
    __dirname,
    '../../prisma/migrations/20260727103000_require_boxlite_terminal_bridge_environment/migration.sql',
  ),
  'utf8',
);

test('sandbox metadata migration stales ready rows from old or null contracts', () => {
  assert.match(
    migrationSql,
    /UPDATE\s+"sandbox_environments"\s+SET\s+"status"\s*=\s*'stale'/i,
  );
  assert.match(migrationSql, /WHERE\s+"status"\s*=\s*'ready'/i);
  assert.match(
    migrationSql,
    /"contract_version"\s+IS\s+DISTINCT\s+FROM\s+'sandbox-environment-v2'/i,
  );
});

test('terminal bridge contract migration stales ready rows from pre-v3 contracts', () => {
  assert.match(
    terminalBridgeContractMigrationSql,
    /UPDATE\s+"sandbox_environments"\s+SET\s+"status"\s*=\s*'stale'/i,
  );
  assert.match(
    terminalBridgeContractMigrationSql,
    /WHERE\s+"status"\s*=\s*'ready'/i,
  );
  assert.match(
    terminalBridgeContractMigrationSql,
    /"contract_version"\s+IS\s+DISTINCT\s+FROM\s+'sandbox-environment-v3'/i,
  );
});
