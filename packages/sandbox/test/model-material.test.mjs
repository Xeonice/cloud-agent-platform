import assert from 'node:assert/strict';
import test from 'node:test';

const sandbox = await import(new URL('../dist/index.js', import.meta.url).href);

function result(exitCode = 0, timedOut = false) {
  return {
    exitCode,
    output: '',
    stdout: '',
    stderr: '',
    timedOut,
  };
}

test('explicit model material uses bounded base64 setup without raw selector text', () => {
  const selector = `arn:vendor:model/$(touch\${IFS}/tmp/pwned);'"`;
  const commands = sandbox.buildTaskModelMaterialCommands({
    kind: 'explicit',
    selector,
  });
  assert.equal(commands.length, 2);
  assert.equal(commands[0].timeoutMs, 10_000);
  assert.equal(commands[1].timeoutMs, 10_000);
  assert.doesNotMatch(commands[0].command, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(commands[0].command, /base64 -d/);
  assert.match(commands[0].command, /task-model\.txt\.tmp/);
  assert.match(commands[0].command, /mv -f .*task-model\.txt/);
  assert.match(commands[1].command, /test -r .*task-model\.txt/);
  assert.match(commands[1].command, /sha256sum/);
});

test('runtime-default model material is a byte-preserving no-op', async () => {
  let calls = 0;
  const material = await sandbox.materializeTaskModel(
    {
      async exec() {
        calls += 1;
        return result();
      },
    },
    { kind: 'runtime-default' },
  );
  assert.deepEqual(material, { kind: 'runtime-default' });
  assert.equal(calls, 0);
});

test('explicit model material is installed and independently verified', async () => {
  const commands = [];
  const material = await sandbox.materializeTaskModel(
    {
      async exec(request) {
        commands.push(request.command);
        return result();
      },
    },
    { kind: 'explicit', selector: 'provider/model:v1' },
  );
  assert.equal(material.kind, 'explicit');
  assert.equal(material.path, '/home/gem/.cap/task-model.txt');
  assert.match(material.checksum, /^sha256:[0-9a-f]{64}$/);
  assert.equal(commands.length, 2);
});

test('write or verification failure removes partial and final material and fails closed', async () => {
  const commands = [];
  let call = 0;
  await assert.rejects(
    sandbox.materializeTaskModel(
      {
        async exec(request) {
          commands.push(request.command);
          call += 1;
          return call === 2 ? result(1) : result();
        },
      },
      { kind: 'explicit', selector: 'provider/model:v1' },
    ),
    (error) =>
      error?.code === 'runtime_model_setup_failed' &&
      error?.phase === 'material-verify',
  );
  assert.equal(commands.length, 3);
  assert.match(commands[2], /rm -f .*task-model\.txt\.tmp.*task-model\.txt/);
});

test('unresolved and timed-out setup exits fail closed', async () => {
  for (const outcome of [result(Number.NaN), result(0, true)]) {
    await assert.rejects(
      sandbox.materializeTaskModel(
        {
          async exec() {
            return outcome;
          },
        },
        { kind: 'explicit', selector: 'provider/model:v1' },
      ),
      (error) => error?.code === 'runtime_model_setup_failed',
    );
  }

  let call = 0;
  await assert.rejects(
    sandbox.materializeTaskModel(
      {
        async exec() {
          call += 1;
          return call === 1 ? result(1) : result();
        },
      },
      { kind: 'explicit', selector: 'provider/model:v1' },
    ),
    (error) => error?.phase === 'material-write',
  );
});

test('invalid explicit model selectors fail before guest execution', async () => {
  assert.deepEqual(
    sandbox.buildTaskModelMaterialCommands({ kind: 'runtime-default' }),
    [],
  );
  assert.throws(
    () => sandbox.buildTaskModelMaterialCommands({ kind: 'explicit', selector: '' }),
    (error) => error?.phase === 'material-write',
  );

  let calls = 0;
  await assert.rejects(
    sandbox.materializeTaskModel(
      {
        async exec() {
          calls += 1;
          return result();
        },
      },
      { kind: 'explicit', selector: '\n' },
    ),
    (error) => error?.phase === 'material-write',
  );
  assert.equal(calls, 0);
});

test('executor failures are classified by write versus independent verification phase', async () => {
  for (const failAt of [1, 2]) {
    let call = 0;
    await assert.rejects(
      sandbox.materializeTaskModel(
        {
          async exec() {
            call += 1;
            if (call === failAt) throw new Error('transport unavailable');
            return result();
          },
        },
        { kind: 'explicit', selector: 'provider/model:v1' },
      ),
      (error) =>
        error?.phase === (failAt === 1 ? 'material-write' : 'material-verify'),
    );
    assert.equal(call, failAt + 1, 'failure cleanup is attempted exactly once');
  }
});

test('failed cleanup remains a material-write failure', async () => {
  for (const cleanupOutcome of [result(1), result(Number.NaN), result(0, true)]) {
    let call = 0;
    await assert.rejects(
      sandbox.materializeTaskModel(
        {
          async exec() {
            call += 1;
            return call === 1 ? result(1) : cleanupOutcome;
          },
        },
        { kind: 'explicit', selector: 'provider/model:v1' },
      ),
      (error) => error?.phase === 'material-write',
    );
  }

  let call = 0;
  await assert.rejects(
    sandbox.materializeTaskModel(
      {
        async exec() {
          call += 1;
          if (call === 1) return result(1);
          throw 'cleanup transport unavailable';
        },
      },
      { kind: 'explicit', selector: 'provider/model:v1' },
    ),
    (error) => error?.phase === 'material-write',
  );
});

test('existing model material is verified without exposing selector contents', async () => {
  let calls = 0;
  const runtimeDefault = await sandbox.verifyTaskModelMaterial(
    {
      async exec() {
        calls += 1;
        return result();
      },
    },
    { kind: 'runtime-default' },
  );
  assert.deepEqual(runtimeDefault, { kind: 'runtime-default' });
  assert.equal(calls, 0);

  const requests = [];
  const explicit = await sandbox.verifyTaskModelMaterial(
    {
      async exec(request) {
        requests.push(request);
        return result();
      },
    },
    { kind: 'explicit', selector: 'provider/model:v1' },
  );
  assert.equal(explicit.kind, 'explicit');
  assert.equal(requests.length, 1);
  assert.doesNotMatch(requests[0].command, /provider\/model:v1/);

  await assert.rejects(
    sandbox.verifyTaskModelMaterial({ exec: async () => result() }, {
      kind: 'explicit',
      selector: '',
    }),
    (error) => error?.phase === 'material-verify',
  );

  for (const outcome of [result(1), result(Number.NaN), result(0, true)]) {
    await assert.rejects(
      sandbox.verifyTaskModelMaterial({ exec: async () => outcome }, {
        kind: 'explicit',
        selector: 'provider/model:v1',
      }),
      (error) => error?.phase === 'material-verify',
    );
  }

  await assert.rejects(
    sandbox.verifyTaskModelMaterial(
      {
        async exec() {
          throw new Error('transport unavailable');
        },
      },
      { kind: 'explicit', selector: 'provider/model:v1' },
    ),
    (error) => error?.phase === 'material-verify',
  );
});
