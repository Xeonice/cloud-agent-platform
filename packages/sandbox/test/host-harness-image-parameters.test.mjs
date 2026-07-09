import assert from 'node:assert/strict';

const mod = await import(new URL('../dist/index.js', import.meta.url).href);

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

function decodeEnvFile(command) {
  const match = /printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > '\/home\/gem\/\.cap\/image-env'/.exec(command);
  assert(match, 'expected base64 write for image-env');
  return Buffer.from(match[1], 'base64').toString('utf8');
}

const profile = {
  parameters: [
    { name: 'GCODE_TOKEN', value: "tok'en-secret", secret: true },
    { name: 'GCODE_API_BASE_URL', value: 'https://code.example/api/v5', secret: false },
  ],
};

await test('image parameter setup writes a private CAP env file', () => {
  const commands = mod.buildSandboxImageParameterSetupCommands(profile);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].tolerateUnresolvedExit, false);
  assert.match(commands[0].command, /mkdir -p '\/home\/gem\/\.cap'/);
  assert.match(commands[0].command, /chmod 600 '\/home\/gem\/\.cap\/image-env'/);

  const envFile = decodeEnvFile(commands[0].command);
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
    "rm -f '/home/gem/.cap/image-env' 2>/dev/null; true",
  ]);
  assert(warnings.some((message) => message.includes('exited 7')));
  assert(warnings.every((message) => !message.includes("tok'en-secret")));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
