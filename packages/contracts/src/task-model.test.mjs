import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const contracts = require(path.join(here, '..', 'dist', 'index.js'));

const {
  CreateScheduleRequestSchema,
  CreateTaskRequestSchema,
  TaskResponseSchema,
  V1CreateTaskRequestSchema,
} = contracts;

const repoId = '11111111-1111-4111-8111-111111111111';
const taskRow = {
  id: '22222222-2222-4222-8222-222222222222',
  repoId,
  prompt: 'run',
  status: 'pending',
  createdAt: '2026-07-14T00:00:00.000Z',
};

const taskCreateSurfaces = [
  {
    name: 'direct',
    parse(model) {
      return CreateTaskRequestSchema.parse({ prompt: 'run', model }).model;
    },
  },
  {
    name: 'V1',
    parse(model) {
      return V1CreateTaskRequestSchema.parse({ repoId, prompt: 'run', model })
        .model;
    },
  },
  {
    name: 'schedule',
    parse(model) {
      return CreateScheduleRequestSchema.parse({
        recurrence: { kind: 'daily', time: '09:00', timezone: 'UTC' },
        taskTemplate: { repoId, prompt: 'run', model },
      }).taskTemplate.model;
    },
  },
];

test('canonical direct task schema trims and retains a model selector', () => {
  const parsed = CreateTaskRequestSchema.parse({
    prompt: 'run',
    model: '  provider/model:v1  ',
  });
  assert.equal(parsed.model, 'provider/model:v1');
});

test('V1 inherits the canonical model selector without a second definition', () => {
  const parsed = V1CreateTaskRequestSchema.parse({
    repoId,
    prompt: 'run',
    model: 'provider/model:v1',
  });
  assert.equal(parsed.model, 'provider/model:v1');
});

test('schedule task templates inherit and normalize the canonical model selector', () => {
  const parsed = CreateScheduleRequestSchema.parse({
    recurrence: { kind: 'daily', time: '09:00', timezone: 'UTC' },
    taskTemplate: {
      repoId,
      prompt: 'run',
      model: '  provider/model:v1  ',
    },
  });
  assert.equal(parsed.taskTemplate.model, 'provider/model:v1');
});

test('task responses distinguish explicit requested model from runtime default intent', () => {
  assert.equal(
    TaskResponseSchema.parse({ ...taskRow, model: 'provider/model:v1' }).model,
    'provider/model:v1',
  );
  assert.equal(TaskResponseSchema.parse({ ...taskRow, model: null }).model, null);
  assert.equal(TaskResponseSchema.parse(taskRow).model, undefined);
});

test('all create surfaces enforce the exact 2048 UTF-8 byte boundary', () => {
  const accepted = [
    'a'.repeat(2_048),
    `${'界'.repeat(682)}aa`,
    '😀'.repeat(512),
  ];
  const rejected = [
    'a'.repeat(2_049),
    `${'界'.repeat(682)}aaa`,
    '😀'.repeat(513),
  ];

  assert.deepEqual(
    accepted.map((value) => Buffer.byteLength(value, 'utf8')),
    [2_048, 2_048, 2_048],
  );
  assert.deepEqual(
    rejected.map((value) => Buffer.byteLength(value, 'utf8')),
    [2_049, 2_049, 2_052],
  );

  for (const surface of taskCreateSurfaces) {
    for (const value of accepted) {
      assert.equal(surface.parse(value), value, `${surface.name} accepts boundary`);
    }
    for (const value of rejected) {
      assert.throws(
        () => surface.parse(value),
        undefined,
        `${surface.name} rejects over-boundary selector`,
      );
    }
  }
});

test('provider-qualified punctuation and ARN-like selectors round-trip unchanged', () => {
  const selectors = [
    'provider/model:v1.2+preview@[region]/family_name',
    'arn:aws:bedrock:us-east-1:123456789012:inference-profile/acme.model-v1:0',
    `provider/model:'quoted'"double"$dollar;semi,comma=equals`,
  ];
  for (const surface of taskCreateSurfaces) {
    for (const selector of selectors) {
      assert.equal(surface.parse(selector), selector, `${surface.name} round-trip`);
    }
  }
});

test('all create surfaces reject empty, null, and C0/C1 control characters', () => {
  const rejected = [
    '',
    '   ',
    null,
    'model\0id',
    'model\nid',
    'model\tid',
    'model\x1fid',
    'model\x7fid',
    'model\x85id',
    '\nmodel',
    'model\n',
  ];
  for (const surface of taskCreateSurfaces) {
    for (const value of rejected) {
      assert.throws(
        () => surface.parse(value),
        undefined,
        `${surface.name} rejects ${JSON.stringify(value)}`,
      );
    }
  }
});
