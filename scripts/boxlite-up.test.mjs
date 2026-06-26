import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const SCRIPT = resolve(repoRoot, 'scripts/boxlite-up.sh');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function listen(server) {
  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen(server.address().port));
  });
}

function runBoxliteUp(args, env = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('bash', [SCRIPT, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', rejectRun);
    child.on('close', (status) => {
      if (status === 0) {
        resolveRun({ stdout, stderr });
        return;
      }
      const error = new Error(`boxlite-up exited ${status}\n${stderr}`);
      error.stdout = stdout;
      error.stderr = stderr;
      rejectRun(error);
    });
  });
}

console.log('\n=== boxlite-up ===\n');

const server = http.createServer((req, res) => {
  if (req.url === '/health' && req.headers.authorization === 'Bearer token-test') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  res.writeHead(404);
  res.end();
});
const port = await listen(server);

try {
  const dir = mkdtempSync(join(tmpdir(), 'boxlite-up-'));
  const envFile = join(dir, '.env');
  const endpoint = `http://127.0.0.1:${port}`;
  await runBoxliteUp(['--env-file', envFile], {
    BOXLITE_ENDPOINT: endpoint,
    BOXLITE_API_TOKEN: 'token-test',
    BOXLITE_IMAGE: 'cap-boxlite:test',
  });

  const env = parseEnv(readFileSync(envFile, 'utf8'));
  assert(env.CAP_SANDBOX_PROVIDER === 'boxlite', 'writes CAP_SANDBOX_PROVIDER=boxlite');
  assert(env.BOXLITE_ENDPOINT === endpoint, 'writes BOXLITE_ENDPOINT from process env');
  assert(env.BOXLITE_API_TOKEN === 'token-test', 'writes BOXLITE_API_TOKEN from process env');
  assert(env.BOXLITE_IMAGE === 'cap-boxlite:test', 'writes BOXLITE_IMAGE from process env');
  assert(env.BOXLITE_PROVIDER_PRIORITY === '100', 'writes high BoxLite priority default');
  assert(env.BOXLITE_TERMINAL_MODE === 'pty', 'writes pty terminal default');
  assert(
    env.BOXLITE_CAPABILITIES.includes('terminal.websocket') &&
      env.BOXLITE_CAPABILITIES.includes('workspace.git.materialize') &&
      env.BOXLITE_CAPABILITIES.includes('workspace.archive.transfer'),
    'writes interactive/materialize/archive capabilities',
  );

  writeFileSync(envFile, `${readFileSync(envFile, 'utf8')}BOXLITE_PROVIDER_PRIORITY=7\n`);
  const envFile2 = join(dir, '.env-existing');
  writeFileSync(envFile2, [
    `BOXLITE_ENDPOINT=${endpoint}`,
    'BOXLITE_API_TOKEN=token-test',
    'BOXLITE_IMAGE=cap-boxlite:test',
    'BOXLITE_PROVIDER_PRIORITY=7',
    '',
  ].join('\n'));
  await runBoxliteUp(['--env-file', envFile2]);
  assert(parseEnv(readFileSync(envFile2, 'utf8')).BOXLITE_PROVIDER_PRIORITY === '7',
    'does not overwrite existing BoxLite env values');
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}

const missing = spawnSync('bash', [SCRIPT, '--env-file', join(mkdtempSync(join(tmpdir(), 'boxlite-up-')), '.env')], {
  cwd: repoRoot,
  env: { ...process.env, BOXLITE_ENDPOINT: '', BOXLITE_API_TOKEN: '', BOXLITE_IMAGE: '' },
  encoding: 'utf8',
});
assert(missing.status === 1, 'missing required BoxLite env exits 1');
assert(/BOXLITE_ENDPOINT is required/.test(missing.stderr), 'missing env failure names BOXLITE_ENDPOINT');

console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
}
console.error('SOME TESTS FAILED');
process.exit(1);
