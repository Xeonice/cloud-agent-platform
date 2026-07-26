const mod = await import(new URL('../dist/index.js', import.meta.url).href);

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`ok - ${label}`);
    passed++;
  } else {
    console.error(`not ok - ${label}`);
    failed++;
  }
}

function aioResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function fakeAioShell({ execStatus = 200, output = () => 'ok\n' } = {}) {
  const calls = [];
  const activeSessionIds = new Set();
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const call = {
      url: String(input),
      path: url.pathname,
      method: init.method ?? 'GET',
      body,
    };
    calls.push(call);

    if (call.path === '/v1/shell/sessions/create') {
      if (call.method !== 'POST' || typeof body?.id !== 'string') {
        throw new Error('invalid fake AIO create request');
      }
      activeSessionIds.add(body.id);
      return aioResponse(200, {
        success: true,
        data: { session_id: body.id, working_dir: '/home/gem' },
      });
    }
    if (call.path === '/v1/shell/exec') {
      if (
        call.method !== 'POST' ||
        typeof body?.id !== 'string' ||
        !activeSessionIds.has(body.id) ||
        typeof body.command !== 'string' ||
        body.async_mode !== false
      ) {
        throw new Error('invalid fake AIO exec request');
      }
      if (execStatus !== 200) return aioResponse(execStatus, { error: 'down' });
      return aioResponse(200, {
        success: true,
        data: {
          session_id: body.id,
          command: body.command,
          status: 'completed',
          exit_code: 0,
          output: output(call),
        },
      });
    }
    if (call.method === 'DELETE' && call.path.startsWith('/v1/shell/sessions/')) {
      const sessionId = decodeURIComponent(
        call.path.slice('/v1/shell/sessions/'.length),
      );
      if (!activeSessionIds.delete(sessionId)) {
        throw new Error('fake AIO delete did not match an active session');
      }
      return aioResponse(200, {
        success: true,
        data: { session_id: sessionId },
      });
    }
    throw new Error(`unexpected fake AIO route: ${call.method} ${call.path}`);
  };
  return { fetch, calls, activeSessionIds };
}

function assertExactAioLifecycle(fake, label) {
  const [create, exec, cleanup] = fake.calls;
  const sessionId = create?.body?.id;
  assert(
    fake.calls.length === 3 &&
      create?.path === '/v1/shell/sessions/create' &&
      create.method === 'POST' &&
      exec?.path === '/v1/shell/exec' &&
      exec.method === 'POST' &&
      exec.body.id === sessionId &&
      cleanup?.method === 'DELETE' &&
      cleanup.path === `/v1/shell/sessions/${encodeURIComponent(sessionId)}`,
    `${label} pairs create, exec, and exact delete`,
  );
  assert(fake.activeSessionIds.size === 0, `${label} leaves no fake AIO session`);
}

function unwrapIsolatedAioCommand(command) {
  const prefix = "sh -lc '";
  if (!command.startsWith(prefix) || !command.endsWith("'")) return null;
  return command.slice(prefix.length, -1).replaceAll("'\\''", "'");
}

const {
  buildSandboxCommandExecutor,
  resolveSandboxCommandDescriptor,
  toLegacySandboxExecResult,
} = mod;
const connection = {
  taskId: 'task-1',
  baseUrl: 'http://aio-default',
  wsUrl: 'ws://aio-default/v1/shell/ws',
};

const fallback = resolveSandboxCommandDescriptor({ connection });
assert(fallback.protocol === 'aio-http-exec-v1', 'fallback command descriptor is AIO exec');
assert(fallback.baseUrl === 'http://aio-default', 'fallback command descriptor uses connection baseUrl');

const selectedRun = {
  command: {
    protocol: 'aio-http-exec-v1',
    baseUrl: 'http://aio-selected',
  },
};
const selected = resolveSandboxCommandDescriptor({ connection, selectedRun });
assert(selected.baseUrl === 'http://aio-selected', 'selected-run command descriptor takes precedence');

const fallbackAio = fakeAioShell({ output: (call) => call.url });
const fallbackBaseUrlExecutor = buildSandboxCommandExecutor({
  connection,
  selectedRun: {
    command: {
      protocol: 'aio-http-exec-v1',
    },
  },
  fetchImpl: fallbackAio.fetch,
});
assert(
  (await fallbackBaseUrlExecutor.exec({ command: 'true' })).output ===
    'http://aio-default/v1/shell/exec',
  'AIO command executor falls back to connection baseUrl',
);
assertExactAioLifecycle(fallbackAio, 'fallback executor');

const selectedAio = fakeAioShell();
const executor = buildSandboxCommandExecutor({
  connection,
  selectedRun,
  fetchImpl: selectedAio.fetch,
});
const result = await executor.exec({
  command: 'git status',
  cwd: '/home/gem/workspace',
  timeoutMs: 10_000,
});
assert(result.exitCode === 0 && result.output === 'ok\n', 'executor normalizes AIO exec result');
assert(
  selectedAio.calls[1].url === 'http://aio-selected/v1/shell/exec',
  'executor uses selected command baseUrl',
);
assert(
  unwrapIsolatedAioCommand(selectedAio.calls[1].body.command) ===
    "cd '/home/gem/workspace' && git status",
  'executor preserves the cwd inside its isolated child shell',
);
assertExactAioLifecycle(selectedAio, 'selected executor');

const legacy = toLegacySandboxExecResult(result);
assert(legacy.exitCode === 0 && legacy.output === 'ok\n', 'legacy exec adapter preserves exitCode/output');

let boxliteSandboxId;
const boxliteExecutor = buildSandboxCommandExecutor({
  connection,
  selectedRun: {
    providerSandboxId: 'box-fallback',
    provider: {
      createCommandExecutor(sandboxId) {
        boxliteSandboxId = sandboxId;
        return {
          async exec() {
            return {
              exitCode: 0,
              output: 'boxlite-ok',
              stdout: 'boxlite-ok',
              stderr: '',
              timedOut: false,
            };
          },
        };
      },
    },
    command: {
      protocol: 'boxlite-exec-v1',
      metadata: { sandboxId: 'box-meta' },
    },
  },
});
assert(
  (await boxliteExecutor.exec({ command: 'true' })).output === 'boxlite-ok',
  'boxlite executor delegates to selected provider command factory',
);
assert(boxliteSandboxId === 'box-meta', 'boxlite executor prefers descriptor sandbox id');

const boxliteFallbackExecutor = buildSandboxCommandExecutor({
  connection,
  selectedRun: {
    providerSandboxId: 'box-provider-run',
    provider: {
      createCommandExecutor(sandboxId) {
        boxliteSandboxId = sandboxId;
        return {
          async exec() {
            return {
              exitCode: 0,
              output: 'boxlite-fallback-ok',
              stdout: 'boxlite-fallback-ok',
              stderr: '',
              timedOut: false,
            };
          },
        };
      },
    },
    command: {
      protocol: 'boxlite-exec-v1',
      metadata: { sandboxId: 123 },
    },
  },
});
assert(
  (await boxliteFallbackExecutor.exec({ command: 'true' })).output ===
    'boxlite-fallback-ok',
  'boxlite executor ignores non-string descriptor sandbox id',
);
assert(boxliteSandboxId === 'box-provider-run', 'boxlite executor falls back to providerSandboxId');

const failedAio = fakeAioShell({ execStatus: 503 });
const failedExecutor = buildSandboxCommandExecutor({
  connection,
  selectedRun,
  fetchImpl: failedAio.fetch,
});
const failedResult = await failedExecutor.exec({ command: 'git status' });
assert(Number.isNaN(failedResult.exitCode), 'executor HTTP failure returns a fail-closed NaN exit code');
assert(
  failedResult.output.includes('/v1/shell/exec responded 503'),
  'executor HTTP failure surfaces a normalized provider error',
);
assertExactAioLifecycle(failedAio, '503 executor');

let missingBoxliteFactory = false;
try {
  buildSandboxCommandExecutor({
    connection,
    selectedRun: { command: { protocol: 'boxlite-exec-v1' } },
  });
} catch (err) {
  missingBoxliteFactory = /requires selected provider executor and sandbox id/.test(String(err?.message ?? err));
}
assert(missingBoxliteFactory, 'boxlite command executor without selected provider fails closed');

let unsupported = false;
try {
  buildSandboxCommandExecutor({
    connection,
    selectedRun: { command: { protocol: 'unknown-exec-v1' } },
  });
} catch (err) {
  unsupported = /unsupported command executor protocol/.test(String(err?.message ?? err));
}
assert(unsupported, 'unsupported command protocol fails closed');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
