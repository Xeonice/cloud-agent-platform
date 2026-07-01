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

const fallbackBaseUrlExecutor = buildSandboxCommandExecutor({
  connection,
  selectedRun: {
    command: {
      protocol: 'aio-http-exec-v1',
    },
  },
  fetchImpl: async (url) => ({
    ok: true,
    status: 200,
    async json() {
      return { data: { exit_code: 0, stdout: String(url) } };
    },
  }),
});
assert(
  (await fallbackBaseUrlExecutor.exec({ command: 'true' })).output ===
    'http://aio-default/v1/shell/exec',
  'AIO command executor falls back to connection baseUrl',
);

const calls = [];
const executor = buildSandboxCommandExecutor({
  connection,
  selectedRun,
  fetchImpl: async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      async json() {
        return { data: { exit_code: 0, stdout: 'ok\n' } };
      },
    };
  },
});
const result = await executor.exec({
  command: 'git status',
  cwd: '/home/gem/workspace',
  timeoutMs: 10_000,
});
assert(result.exitCode === 0 && result.output === 'ok\n', 'executor normalizes AIO exec result');
assert(calls[0].url === 'http://aio-selected/v1/shell/exec', 'executor uses selected command baseUrl');
assert(
  calls[0].body.command === "cd '/home/gem/workspace' && git status",
  'executor wraps cwd before sending command',
);

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

const failedExecutor = buildSandboxCommandExecutor({
  connection,
  selectedRun,
  fetchImpl: async () => ({
    ok: false,
    status: 503,
    async json() {
      return { error: 'down' };
    },
  }),
});
const failedResult = await failedExecutor.exec({ command: 'git status' });
assert(Number.isNaN(failedResult.exitCode), 'executor HTTP failure returns a fail-closed NaN exit code');
assert(
  failedResult.output.includes('/v1/shell/exec responded 503'),
  'executor HTTP failure surfaces a normalized provider error',
);

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
