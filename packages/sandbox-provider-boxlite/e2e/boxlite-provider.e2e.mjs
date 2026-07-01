import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const mod = await import(new URL('../dist/index.js', import.meta.url).href);

const LIVE_ENABLED =
  process.env.BOXLITE_PROVIDER_E2E === '1' || process.env.BOXLITE_LIVE_TEST === '1';
const DEFAULT_TIMEOUT_MS = Number(process.env.BOXLITE_PROVIDER_E2E_TIMEOUT_MS ?? 180_000);

test(
  'BoxLite provider e2e provisions, execs, describes, readopts, and cleans up a real sandbox',
  { timeout: DEFAULT_TIMEOUT_MS },
  async (t) => {
    if (!LIVE_ENABLED) {
      t.skip('set BOXLITE_PROVIDER_E2E=1 with valid BOXLITE_* configuration');
      return;
    }

    const config = requireLiveBoxLiteConfig();
    const descriptor = mod.defineBoxLiteSandboxProvider({ config });
    const provider = descriptor.provider;
    const taskId = `provider-e2e-${randomUUID().slice(0, 8)}`;
    let cleanupProvider = provider;

    try {
      const connection = await provider.provision({ taskId, cloneSpec: null });
      assert.equal(connection.taskId, taskId);
      assert.equal(await provider.sandboxExists(taskId), true);

      const selected = await provider.getSelectedSandboxRun(taskId);
      assert.equal(selected.providerId, config.providerId);
      assert.equal(selected.providerSandboxId, `${config.sandboxIdPrefix}${taskId}`);
      assert.equal(selected.command.protocol, 'boxlite-exec-v1');
      assert.equal(selected.workspace.path, config.workspacePath);
      assert.equal(selected.retention.cleanupEligible, true);
      assert.ok(
        selected.preflight.status === 'passed' || selected.preflight.status === 'skipped',
        `unexpected preflight status ${selected.preflight.status}`,
      );
      if (config.capabilities.includes('terminal.interactive')) {
        assert.equal(selected.terminal?.protocol, 'boxlite-v1');
      }

      const executor = provider.createCommandExecutor(selected.providerSandboxId);
      const marker = `boxlite-provider-e2e-${randomUUID()}`;
      const exec = await executor.exec({
        command:
          `mkdir -p ${shellQuote(config.workspacePath)} && ` +
          `printf %s ${shellQuote(marker)} > ${shellQuote(`${config.workspacePath}/provider-e2e.txt`)} && ` +
          `cat ${shellQuote(`${config.workspacePath}/provider-e2e.txt`)}`,
        cwd: config.workspacePath,
        timeoutMs: 30_000,
      });
      assert.equal(exec.exitCode, 0, exec.output);
      assert.equal(exec.output.trim(), marker);

      if (config.capabilities.includes('workspace.archive.transfer')) {
        const archivePath = `${config.workspacePath}/provider-e2e-archive.txt`;
        const payload = new TextEncoder().encode(`boxlite-archive-${randomUUID()}`);
        await provider.uploadWorkspaceArchive({
          taskId,
          path: archivePath,
          archive: payload,
        });
        const downloaded = await provider.downloadWorkspaceArchive({
          taskId,
          path: archivePath,
        });
        assert.deepEqual(
          downloaded ? [...downloaded] : null,
          [...payload],
          'BoxLite advertised workspace.archive.transfer but upload/download did not round-trip',
        );
      }

      cleanupProvider = null;
      const readoptedDescriptor = mod.defineBoxLiteSandboxProvider({ config });
      const readoptedProvider = readoptedDescriptor.provider;
      cleanupProvider = readoptedProvider;
      const reattached = await readoptedProvider.reattach(taskId);
      assert.equal(reattached?.baseUrl, connection.baseUrl);
      const readoptedRun = await readoptedProvider.getSelectedSandboxRun(taskId);
      assert.equal(readoptedRun.providerSandboxId, selected.providerSandboxId);
      assert.equal(readoptedRun.command.protocol, 'boxlite-exec-v1');

      await readoptedProvider.teardownSandbox(taskId);
      cleanupProvider = null;
      assert.equal(await readoptedProvider.sandboxExists(taskId), false);
    } finally {
      if (cleanupProvider) {
        await cleanupProvider.teardownSandbox(taskId).catch(() => undefined);
      }
    }
  },
);

function requireLiveBoxLiteConfig() {
  const result = mod.readBoxLiteProviderConfig(process.env);
  if (result.status === 'disabled') {
    throw new Error(
      `BOXLITE_PROVIDER_E2E=1 requires BoxLite configuration: ${result.reason}`,
    );
  }
  if (result.status === 'invalid') {
    throw new Error(
      `BOXLITE_PROVIDER_E2E=1 has invalid BOXLITE_* configuration: ${result.errors.join('; ')}`,
    );
  }
  if (!result.config.capabilities.includes('command.exec')) {
    throw new Error(
      'BoxLite provider e2e requires BOXLITE_CAPABILITIES to include command.exec; it will not fall back to AIO',
    );
  }
  return result.config;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
