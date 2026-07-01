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

const { resolveTerminalDescriptor, buildSandboxTerminalTransportFactory } = mod;
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

const factory = buildSandboxTerminalTransportFactory({
  taskId: 'task-1',
  connection,
  selectedRun,
});
assert(typeof factory.open === 'function', 'AIO descriptor builds a sandbox transport factory');

const urlOnlyFactory = buildSandboxTerminalTransportFactory({
  taskId: 'task-url-only',
  connection,
  selectedRun: {
    terminal: {
      protocol: 'aio-json-v1',
      url: 'ws://aio-url-only/v1/shell/ws',
    },
  },
});
assert(
  typeof urlOnlyFactory.open === 'function',
  'AIO descriptor accepts url-only terminal descriptors',
);

const connectionFallbackFactory = buildSandboxTerminalTransportFactory({
  taskId: 'task-terminal-protocol-only',
  connection,
  selectedRun: {
    terminal: {
      protocol: 'aio-json-v1',
    },
  },
});
assert(
  typeof connectionFallbackFactory.open === 'function',
  'AIO descriptor falls back to connection wsUrl',
);

const boxliteFactory = buildSandboxTerminalTransportFactory({
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
assert(
  typeof boxliteFactory.open === 'function',
  'BoxLite descriptor builds a sandbox transport factory',
);

let unsupported = false;
try {
  buildSandboxTerminalTransportFactory({
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

const pty = mod.openSandboxTerminalPty({
  connection,
  selectedRun,
  onExit() {},
  mode: 'attach-only',
  resolveRuntime: async () => undefined,
  resolveExecutionMode: async () => 'interactive',
});
assert(pty.taskId === 'task-1', 'openSandboxTerminalPty returns a task-bound PTY client');

const defaultModePty = mod.openSandboxTerminalPty({
  connection,
  selectedRun,
});
assert(
  defaultModePty.taskId === 'task-1',
  'openSandboxTerminalPty defaults launch-or-attach mode',
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
