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

await test('git clone command keeps auth in http.extraHeader and escapes single quotes', () => {
  assert.equal(
    mod.buildGitCloneCommand({ url: 'https://example.test/repo.git' }, '/workspace'),
    "git clone -- 'https://example.test/repo.git' '/workspace'",
  );
  assert.equal(
    mod.buildGitCloneCommand(
      {
        url: 'https://example.test/private.git',
        authHeader: "Authorization: Basic tok'en",
      },
      '/workspace',
    ),
    "git -c 'http.extraHeader=Authorization: Basic tok'\\''en' clone -- 'https://example.test/private.git' '/workspace'",
  );
});

await test('git workspace commands shell-quote adversarial dynamic inputs', () => {
  assert.equal(
    mod.buildGitCloneCommand(
      { url: "https://example.test/repo.git; touch /tmp/pwn'$(whoami)" },
      "/workspace path/with spaces'; rm -rf /",
    ),
    "git clone -- 'https://example.test/repo.git; touch /tmp/pwn'\\''$(whoami)' '/workspace path/with spaces'\\''; rm -rf /'",
  );
});

await test('git delivery commands write commit messages through a file and push with auth header', () => {
  const commands = mod.buildGitDeliveryCommands({
    workspaceDir: '/workspace',
    authHeader: "Authorization: Basic tok'en",
    branch: 'cap/task-1',
    commitMessage: 'hello\nworld',
  });
  assert.equal(commands.status, "git -C '/workspace' status --porcelain");
  assert.match(commands.writeCommitMessage, /^printf %s '[A-Za-z0-9+/=]+' \| base64 -d > '\/tmp\/cap-commit-msg'$/);
  assert.match(commands.commit, /commit -F '\/tmp\/cap-commit-msg'$/);
  assert.equal(commands.revParse, "git -C '/workspace' rev-parse HEAD");
  assert.equal(
    commands.push,
    "git -C '/workspace' -c 'http.extraHeader=Authorization: Basic tok'\\''en' push --force-with-lease origin 'cap/task-1'",
  );
  assert(!commands.commit.includes('hello'), 'raw commit message is not on the shell line');
});

await test('sandbox exec scrubber redacts credential-bearing URLs and basic auth headers', () => {
  assert.equal(
    mod.scrubSandboxExecSecrets(
      'fatal https://user:token@example.test/repo.git Authorization: Basic abc123',
    ),
    'fatal https://***:***@example.test/repo.git Authorization: Basic ***',
  );
  assert.equal(mod.scrubSandboxExecSecrets('plain output'), 'plain output');
});

await test('sandbox exec parser handles every supported exit-code and output shape', () => {
  assert.deepEqual(mod.parseSandboxExecResult({ data: { exit_code: 0, output: 'ok' } }), {
    exitCode: 0,
    output: 'ok',
  });
  assert.deepEqual(mod.parseSandboxExecResult({ data: { exit_code: '1', stderr: 'err' } }), {
    exitCode: 1,
    output: 'err',
  });
  assert.deepEqual(mod.parseSandboxExecResult({ exitCode: 2, stdout: 'out' }), {
    exitCode: 2,
    output: 'out',
  });
  assert.deepEqual(mod.parseSandboxExecResult({ code: '3' }), {
    exitCode: 3,
    output: '',
  });
  for (const raw of [
    { data: { exit_code: '' } },
    { data: { exit_code: 'nope' } },
    { data: { exit_code: Number.POSITIVE_INFINITY } },
    undefined,
  ]) {
    const parsed = mod.parseSandboxExecResult(raw);
    assert(Number.isNaN(parsed.exitCode));
    assert.equal(parsed.output, '');
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
