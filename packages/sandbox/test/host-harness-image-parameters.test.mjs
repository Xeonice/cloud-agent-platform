import assert from 'node:assert/strict';

const mod = await import(new URL('../dist/index.js', import.meta.url).href);
const core = await import(
  new URL('../../sandbox-core/dist/index.js', import.meta.url).href
);

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(err);
  }
}

async function consumePrivateFiles(files) {
  const writes = [];
  const port = core.createSandboxRuntimePrivateFilePort({
    rootDirectory: '/home/gem',
    transport: {
      async writeFile(request) {
        writes.push({
          path: request.path,
          mode: request.mode,
          content: Buffer.from(request.content).toString('utf8'),
        });
      },
      async deleteFile() {},
    },
  });
  for (const file of files) await port.writeFile(file);
  return writes;
}

const profile = {
  parameters: [
    { name: 'GCODE_TOKEN', value: "tok'en-secret", secret: true },
    { name: 'GCODE_API_BASE_URL', value: 'https://code.example/api/v5', secret: false },
  ],
};

await test('image parameter setup writes a private CAP env file', async () => {
  const commands = mod.buildSandboxImageParameterSetupCommands(profile);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].tolerateUnresolvedExit, false);
  assert.match(commands[0].command, /test -s '\/home\/gem\/\.cap\/image-env'/);
  assert.match(commands[0].command, /stat -c %a/);
  assert.doesNotMatch(commands[0].command, /base64|GCODE_TOKEN|tok'en-secret/u);
  assert.doesNotMatch(
    JSON.stringify(commands),
    /tok'en-secret|dG9rJ2VuLXNlY3JldA==/u,
  );

  const writes = await consumePrivateFiles(commands[0].privateFiles);
  assert.deepEqual(writes.map(({ path, mode }) => ({ path, mode })), [
    { path: '/home/gem/.cap/image-env', mode: 0o600 },
  ]);
  const envFile = writes[0].content;
  assert.match(envFile, /export GCODE_API_BASE_URL='https:\/\/code\.example\/api\/v5'/);
  assert.match(envFile, /export GCODE_TOKEN='tok'\\''en-secret'/);
});

await test('image parameter setup omits commands when no usable parameters exist', () => {
  assert.deepEqual(mod.buildSandboxImageParameterSetupCommands(null), []);
  assert.deepEqual(
    mod.buildSandboxImageParameterSetupCommands({
      parameters: [{ name: 'bad-name', value: 'x', secret: true }],
    }),
    [],
  );
});

await test('image parameter redaction covers secret raw and base64 forms only', () => {
  const raw =
    "failed token=tok'en-secret b64=dG9rJ2VuLXNlY3JldA== url=https://code.example/api/v5";
  assert.equal(
    mod.scrubSandboxImageParameterSecrets(raw, profile),
    'failed token=*** b64=*** url=https://code.example/api/v5',
  );
});

await test('image parameter cleanup is best effort and never logs values', async () => {
  const warnings = [];
  const calls = [];
  await mod.removeSandboxImageParameterFileBestEffort({
    taskId: 'task-1',
    warn: (message) => warnings.push(message),
    executor: {
      async exec(request) {
        calls.push(request);
        return { exitCode: 7, output: "tok'en-secret", stdout: '', stderr: '', timedOut: false };
      },
    },
  });
  assert.deepEqual(calls.map((call) => call.command), [
    "rm -f '/home/gem/.cap/image-env' && test ! -e '/home/gem/.cap/image-env'",
  ]);
  assert(warnings.some((message) => message.includes('was not confirmed')));
  assert(warnings.every((message) => !message.includes("tok'en-secret")));
});

await test('image parameter normalization and empty redaction are deterministic', async () => {
  const normalized = mod.buildSandboxImageParameterSetupCommands({
    parameters: [
      { name: '_VALID_1', value: '', secret: true },
      { name: '_VALID_1', value: 'ignored duplicate', secret: true },
      { name: '1INVALID', value: 'ignored', secret: true },
    ],
  });
  assert.equal(normalized.length, 1);
  const writes = await consumePrivateFiles(normalized[0].privateFiles);
  assert.equal(writes[0].content, "export _VALID_1=''\n");
  assert.equal(mod.scrubSandboxImageParameterSecrets('', profile), '');
  assert.equal(mod.scrubSandboxImageParameterSecrets('unchanged', null), 'unchanged');
  assert.equal(
    mod.scrubSandboxImageParameterSecrets('empty secret remains safe', {
      parameters: [{ name: 'EMPTY_SECRET', value: '', secret: true }],
    }),
    'empty secret remains safe',
  );
});

await test('image parameter cleanup tolerates success and thrown values', async () => {
  const successfulWarnings = [];
  await mod.removeSandboxImageParameterFileBestEffort({
    taskId: 'task-success',
    warn: (message) => successfulWarnings.push(message),
    executor: { exec: async () => ({ exitCode: 0 }) },
  });
  assert.deepEqual(successfulWarnings, []);

  for (const thrown of [new Error('transport down'), 'transport down']) {
    const warnings = [];
    await mod.removeSandboxImageParameterFileBestEffort({
      taskId: 'task-throw',
      warn: (message) => warnings.push(message),
      executor: {
        async exec() {
          throw thrown;
        },
      },
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /did not settle/);
    assert.doesNotMatch(warnings[0], /transport down/);
  }

  await mod.removeSandboxImageParameterFileBestEffort({
    taskId: 'task-without-logger',
    executor: { exec: async () => ({ exitCode: 9 }) },
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
