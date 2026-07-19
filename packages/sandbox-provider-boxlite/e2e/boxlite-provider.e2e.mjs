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
    let cleanupRequired = true;

    try {
      const connection = await provider.provision({ taskId, cloneSpec: null });
      assert.equal(connection.taskId, taskId);
      assert.equal(await provider.sandboxExists(taskId), true);

      const selected = await provider.getSelectedSandboxRun(taskId);
      assert.equal(selected.providerId, config.providerId);
      assert.ok(
        selected.providerSandboxId,
        'BoxLite should return a provider sandbox id after native create/start',
      );
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

      for (let index = 0; index < 50; index += 1) {
        const fastMarker = `boxlite-fast-${index}-${randomUUID()}`;
        const fast = await executor.exec({
          command: `printf %s ${shellQuote(fastMarker)}`,
          cwd: config.workspacePath,
          timeoutMs: 30_000,
        });
        assert.equal(fast.exitCode, 0, fast.output);
        assert.equal(fast.stdout, fastMarker);
        assert.equal(fast.stderr, '');
        assert.equal(fast.output, fastMarker);
      }

      const empty = await executor.exec({
        command: ':',
        cwd: config.workspacePath,
        timeoutMs: 30_000,
      });
      assert.equal(empty.exitCode, 0, empty.output);
      assert.equal(empty.stdout, '');
      assert.equal(empty.stderr, '');
      assert.equal(empty.output, '');

      const stderrMarker = `boxlite-stderr-${randomUUID()}`;
      const nonZero = await executor.exec({
        command: `printf %s ${shellQuote(stderrMarker)} >&2; exit 7`,
        cwd: config.workspacePath,
        timeoutMs: 30_000,
      });
      assert.equal(nonZero.exitCode, 7);
      assert.equal(nonZero.stdout, '');
      assert.equal(nonZero.stderr, stderrMarker);
      assert.equal(nonZero.output, stderrMarker);

      const metadataResult = await executor.exec({
        command: 'cat /etc/cap/sandbox-metadata.json',
        timeoutMs: 30_000,
      });
      assert.equal(metadataResult.exitCode, 0, metadataResult.output);
      const metadata = JSON.parse(metadataResult.stdout);
      assert.equal(metadata.schemaVersion, 1);
      assert.equal(
        typeof metadata.sandboxVersion === 'string' &&
          metadata.sandboxVersion.length > 0,
        true,
      );
      assert.equal(
        metadata.dependencies !== null &&
          typeof metadata.dependencies === 'object' &&
          !Array.isArray(metadata.dependencies) &&
          Object.keys(metadata.dependencies).length > 0,
        true,
      );

      if (config.capabilities.includes('workspace.archive.transfer')) {
        const archiveName = `provider-e2e-archive-${randomUUID()}.txt`;
        const payload = `boxlite-archive-${randomUUID()}`;
        await provider.uploadWorkspaceArchive({
          taskId,
          path: config.workspacePath,
          archive: tar([{ name: archiveName, content: payload }]),
        });
        const downloaded = await provider.downloadWorkspaceArchive({
          taskId,
          path: config.workspacePath,
        });
        assert.equal(
          downloaded ? readTarEntry(downloaded, archiveName) : null,
          payload,
          'BoxLite advertised workspace.archive.transfer but upload/download did not round-trip',
        );
      }

      const readoptedDescriptor = mod.defineBoxLiteSandboxProvider({ config });
      const readoptedProvider = readoptedDescriptor.provider;
      cleanupProvider = readoptedProvider;
      const reattached = await readoptedProvider.reattach(taskId);
      assert.equal(reattached?.baseUrl, connection.baseUrl);
      const readoptedRun = await readoptedProvider.getSelectedSandboxRun(taskId);
      assert.equal(readoptedRun.providerSandboxId, selected.providerSandboxId);
      assert.equal(readoptedRun.command.protocol, 'boxlite-exec-v1');

      await readoptedProvider.teardownSandbox(taskId);
      assert.equal(await readoptedProvider.sandboxExists(taskId), false);
      cleanupRequired = false;
      cleanupProvider = null;
    } finally {
      if (cleanupRequired && cleanupProvider) {
        await cleanupProvider.teardownSandbox(taskId);
        assert.equal(
          await cleanupProvider.sandboxExists(taskId),
          false,
          'BoxLite provider e2e probe sandbox must be removed in finally',
        );
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
  if (result.config.protocolMode !== 'native') {
    throw new Error(
      'BoxLite provider e2e output-drain coverage requires BOXLITE_PROTOCOL_MODE=native',
    );
  }
  return result.config;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

const TAR_BLOCK = 512;

function tar(entries) {
  return Buffer.concat([
    ...entries.map((entry) => tarEntry(entry.name, entry.content)),
    Buffer.alloc(TAR_BLOCK * 2),
  ]);
}

function tarEntry(name, content) {
  const body = Buffer.from(content);
  const header = Buffer.alloc(TAR_BLOCK);
  writeTarString(header, 0, 100, name);
  writeTarString(header, 100, 8, '0000644\0');
  writeTarString(header, 108, 8, '0000000\0');
  writeTarString(header, 116, 8, '0000000\0');
  writeTarString(header, 124, 12, tarOctal(body.length, 12));
  writeTarString(header, 136, 12, '00000000000\0');
  header.fill(0x20, 148, 156);
  writeTarString(header, 156, 1, '0');
  writeTarString(header, 257, 6, 'ustar\0');
  let sum = 0;
  for (const byte of header) sum += byte;
  writeTarString(header, 148, 8, tarOctal(sum, 8));
  const padding = Buffer.alloc(Math.ceil(body.length / TAR_BLOCK) * TAR_BLOCK - body.length);
  return Buffer.concat([header, body, padding]);
}

function readTarEntry(archive, expectedName) {
  const buffer = Buffer.from(archive);
  for (let offset = 0; offset + TAR_BLOCK <= buffer.length;) {
    const name = buffer.subarray(offset, offset + 100).toString('utf8').replace(/\0.*$/, '');
    if (!name) return null;
    const sizeText = buffer
      .subarray(offset + 124, offset + 136)
      .toString('utf8')
      .replace(/\0.*$/, '')
      .trim();
    const size = parseInt(sizeText || '0', 8);
    const contentStart = offset + TAR_BLOCK;
    const contentEnd = contentStart + size;
    if (name === expectedName || name.endsWith(`/${expectedName}`)) {
      return buffer.subarray(contentStart, contentEnd).toString('utf8');
    }
    offset = contentStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  return null;
}

function tarOctal(value, length) {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

function writeTarString(buffer, offset, length, value) {
  buffer.write(value.slice(0, length), offset, length, 'utf8');
}
