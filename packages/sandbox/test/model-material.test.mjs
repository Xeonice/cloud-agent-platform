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
});
