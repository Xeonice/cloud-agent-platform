/**
 * Schema validation for the system-level task slot ceiling `maxConcurrentTasks`
 * (configurable-task-slots, task 1.2). Drives the REAL compiled zod schemas
 * from dist/ — the contract is the single source of truth shared by api + web,
 * so this guards that the ceiling accepts exactly the integers 1–20 (default 5)
 * and rejects 0, 21, negatives, and non-integers without ever admitting an
 * out-of-range value onto the wire.
 *
 * Requires `pnpm --filter @cap/contracts build` first. Run: `node settings-slots.test.mjs`.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  MaxConcurrentTasksSchema,
  DEFAULT_MAX_CONCURRENT_TASKS,
  AccountSettingsSchema,
  UpdateSettingsRequestSchema,
} = require(path.join(here, '..', 'dist', 'settings.js'));

const baseSettings = {
  allowedAccount: 'tanghehui',
  defaultRepoId: null,
  retention: 30,
  writeConfirm: true,
};

test('MaxConcurrentTasksSchema accepts every integer 1–20', () => {
  for (let n = 1; n <= 20; n += 1) {
    assert.equal(MaxConcurrentTasksSchema.parse(n), n);
  }
});

test('MaxConcurrentTasksSchema rejects 0, 21, negatives, and non-integers', () => {
  for (const bad of [0, 21, -1, -20, 1.5, 4.999, 20.0001, Number.NaN]) {
    assert.throws(
      () => MaxConcurrentTasksSchema.parse(bad),
      `expected ${bad} to be rejected`,
    );
  }
});

test('MaxConcurrentTasksSchema rejects non-number values', () => {
  for (const bad of ['5', null, undefined, true, {}, []]) {
    assert.throws(
      () => MaxConcurrentTasksSchema.parse(bad),
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

test('default is 5', () => {
  assert.equal(DEFAULT_MAX_CONCURRENT_TASKS, 5);
});

test('AccountSettings read shape defaults an absent ceiling to 5 (optional on the wire)', () => {
  const parsed = AccountSettingsSchema.parse(baseSettings);
  assert.equal(parsed.maxConcurrentTasks, 5);
});

test('AccountSettings read shape defaults an absent default image to null', () => {
  const parsed = AccountSettingsSchema.parse(baseSettings);
  assert.equal(parsed.defaultSandboxEnvironmentId, null);
});

test('AccountSettings read shape echoes an in-range ceiling exactly', () => {
  for (const n of [1, 8, 20]) {
    const parsed = AccountSettingsSchema.parse({ ...baseSettings, maxConcurrentTasks: n });
    assert.equal(parsed.maxConcurrentTasks, n);
  }
});

test('AccountSettings read shape rejects an out-of-range ceiling', () => {
  for (const bad of [0, 21, -3, 7.5]) {
    assert.throws(() => AccountSettingsSchema.parse({ ...baseSettings, maxConcurrentTasks: bad }));
  }
});

test('UpdateSettingsRequest accepts an in-range ceiling and preserves it', () => {
  for (const n of [1, 5, 20]) {
    const parsed = UpdateSettingsRequestSchema.parse({ maxConcurrentTasks: n });
    assert.equal(parsed.maxConcurrentTasks, n);
  }
});

test('UpdateSettingsRequest without the ceiling stays undefined (omit = no change, never fabricated)', () => {
  const parsed = UpdateSettingsRequestSchema.parse({ writeConfirm: false });
  assert.equal(parsed.maxConcurrentTasks, undefined);
});

test('UpdateSettingsRequest accepts setting and clearing the user default image', () => {
  const id = '00000000-0000-4000-a000-000000000777';
  assert.equal(
    UpdateSettingsRequestSchema.parse({ defaultSandboxEnvironmentId: id })
      .defaultSandboxEnvironmentId,
    id,
  );
  assert.equal(
    UpdateSettingsRequestSchema.parse({ defaultSandboxEnvironmentId: null })
      .defaultSandboxEnvironmentId,
    null,
  );
});

test('UpdateSettingsRequest rejects 0, 21, negatives, and non-integers', () => {
  for (const bad of [0, 21, -1, 2.5, '10', true]) {
    assert.throws(
      () => UpdateSettingsRequestSchema.parse({ maxConcurrentTasks: bad }),
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});
