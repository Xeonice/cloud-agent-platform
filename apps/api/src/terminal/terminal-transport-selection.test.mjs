import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..', '..');
const repoRoot = resolve(apiRoot, '..', '..');
const tscBin = join(repoRoot, 'node_modules', '.bin', 'tsc');
const src = join(__dirname, 'terminal-transport-selection.ts');

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(p, name);
      if (found) return found;
    } else if (entry.name === name) {
      return p;
    }
  }
  return null;
}

const outDir = mkdtempSync(join(apiRoot, '.terminal-transport-selection-test-'));

function compile() {
  execFileSync(
    tscBin,
    [
      src,
      '--outDir',
      outDir,
      '--module',
      'commonjs',
      '--moduleResolution',
      'node',
      '--target',
      'ES2021',
      '--experimentalDecorators',
      '--emitDecoratorMetadata',
      '--esModuleInterop',
      '--skipLibCheck',
    ],
    { cwd: apiRoot, stdio: 'pipe' },
  );
  const flat = join(outDir, 'terminal-transport-selection.js');
  if (existsSync(flat)) return flat;
  const nested = join(outDir, 'terminal', 'terminal-transport-selection.js');
  if (existsSync(nested)) return nested;
  const hit = findFile(outDir, 'terminal-transport-selection.js');
  if (hit) return hit;
  throw new Error('compiled terminal-transport-selection.js not found under ' + outDir);
}

try {
  const mod = await import(pathToFileURL(compile()).href);
  const { resolveTerminalDescriptor, buildTerminalTransportFactory } = mod;
  const connection = {
    taskId: 'task-1',
    baseUrl: 'http://aio',
    wsUrl: 'ws://aio-default/v1/shell/ws',
  };

  const fallback = resolveTerminalDescriptor({ connection });
  assert(fallback.protocol === 'aio-json-v1', 'connection fallback uses AIO terminal protocol');
  assert(fallback.wsUrl === connection.wsUrl, 'connection fallback uses the legacy wsUrl');

  const withConnectionDescriptor = resolveTerminalDescriptor({
    connection: {
      ...connection,
      terminal: {
        protocol: 'aio-json-v1',
        wsUrl: 'ws://aio-from-connection/v1/shell/ws',
      },
    },
  });
  assert(
    withConnectionDescriptor.wsUrl === 'ws://aio-from-connection/v1/shell/ws',
    'connection terminal descriptor is consumed when present',
  );

  const selectedRun = {
    terminal: {
      protocol: 'aio-json-v1',
      wsUrl: 'ws://aio-from-selected-run/v1/shell/ws',
    },
  };
  const selected = resolveTerminalDescriptor({
    connection: {
      ...connection,
      terminal: {
        protocol: 'aio-json-v1',
        wsUrl: 'ws://aio-from-connection/v1/shell/ws',
      },
    },
    selectedRun,
  });
  assert(
    selected.wsUrl === 'ws://aio-from-selected-run/v1/shell/ws',
    'selected-run terminal descriptor takes precedence over connection fallback',
  );

  const factory = buildTerminalTransportFactory({
    taskId: 'task-1',
    connection,
    selectedRun,
  });
  assert(typeof factory.open === 'function', 'AIO descriptor builds an API-side transport factory');

  const boxliteFactory = buildTerminalTransportFactory({
    taskId: 'task-2',
    connection,
    selectedRun: {
      terminal: {
        protocol: 'boxlite-v1',
        wsUrl: 'wss://boxlite.example.test',
        metadata: {
          endpoint: 'https://boxlite.example.test',
          sandboxId: 'box-task-2',
          pathPrefix: 'default',
          workspacePath: '/workspace',
        },
      },
    },
  });
  assert(typeof boxliteFactory.open === 'function', 'BoxLite descriptor builds an API-side transport factory');

  let unsupported = false;
  try {
    buildTerminalTransportFactory({
      taskId: 'task-3',
      connection,
      selectedRun: {
        terminal: {
          protocol: 'unknown-provider',
          wsUrl: 'wss://provider/internal',
        },
      },
    });
  } catch (err) {
    unsupported = /unsupported terminal transport protocol/.test(String(err?.message ?? err));
  }
  assert(unsupported, 'unknown provider terminal protocol fails before browser attach');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
