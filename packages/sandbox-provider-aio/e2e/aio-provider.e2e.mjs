import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const mod = await import(new URL('../dist/index.js', import.meta.url).href);

const LIVE_ENABLED = process.env.AIO_PROVIDER_E2E === '1';
const DEFAULT_TIMEOUT_MS = Number(process.env.AIO_PROVIDER_E2E_TIMEOUT_MS ?? 180_000);

test(
  'AIO provider e2e provisions, execs, describes, readopts, and cleans up a real container',
  { timeout: DEFAULT_TIMEOUT_MS },
  async (t) => {
    if (!LIVE_ENABLED) {
      t.skip('set AIO_PROVIDER_E2E=1 with Docker, AIO_SANDBOX_IMAGE, and Docker-network DNS access');
      return;
    }

    const Docker = await loadDocker();
    const docker = new Docker();
    await assertAioPrerequisites(docker);

    const taskId = `provider-e2e-${randomUUID().slice(0, 8)}`;
    const containerName = mod.buildAioSandboxContainerName(taskId);
    let activeProvider = null;

    try {
      const first = createProvider(docker);
      activeProvider = first.provider;
      const connection = await first.provider.provision({ taskId, cloneSpec: null });
      assert.equal(connection.taskId, taskId);
      assert.equal(connection.baseUrl, `http://${containerName}:8080`);

      const executor = first.provider.createCommandExecutor(connection.baseUrl);
      const marker = `aio-provider-e2e-${randomUUID()}`;
      const write = await executor.exec({
        command:
          `mkdir -p ${shellQuote(mod.AIO_SANDBOX_WORKSPACE_DIR)} && ` +
          `printf %s ${shellQuote(marker)} > ${shellQuote(`${mod.AIO_SANDBOX_WORKSPACE_DIR}/provider-e2e.txt`)} && ` +
          `cat ${shellQuote(`${mod.AIO_SANDBOX_WORKSPACE_DIR}/provider-e2e.txt`)}`,
        timeoutMs: 15_000,
      });
      assert.equal(write.exitCode, 0, write.output);
      assert.equal(write.output.trim(), marker);

      const sessionName = `task${taskId}`;
      const tmux = await executor.exec({
        command:
          `tmux has-session -t ${shellQuote(sessionName)} 2>/dev/null || ` +
          `tmux new-session -d -s ${shellQuote(sessionName)} 'sleep 300'`,
        timeoutMs: 15_000,
      });
      assert.equal(tmux.exitCode, 0, tmux.output);

      const selected = await first.provider.getSelectedSandboxRun(taskId);
      assert.equal(selected.providerId, 'aio-local');
      assert.equal(selected.providerSandboxId, taskId);
      assert.equal(selected.terminal.protocol, 'aio-json-v1');
      assert.equal(selected.command.protocol, 'aio-http-exec-v1');
      assert.equal(selected.workspace.path, mod.AIO_SANDBOX_WORKSPACE_DIR);
      assert.equal(selected.workspace.mode, 'git');
      assert.equal(selected.retention.mode, 'stop-retain');
      assert.equal(selected.preflight.status, 'passed');

      first.provider.releaseHandles();
      activeProvider = null;

      const second = createProvider(docker);
      activeProvider = second.provider;
      const readoptable = await second.provider.listReadoptable();
      assert.ok(
        readoptable.includes(taskId),
        `expected ${taskId} in readoptable tasks, got ${JSON.stringify(readoptable)}`,
      );

      const reattached = await second.provider.reattach(taskId);
      assert.equal(reattached?.baseUrl, connection.baseUrl);
      const readoptedRun = await second.provider.getSelectedSandboxRun(taskId);
      assert.equal(readoptedRun.providerSandboxId, taskId);
      assert.equal(readoptedRun.command.protocol, 'aio-http-exec-v1');

      await second.provider.teardownSandbox(taskId);
      await second.provider.removeSandbox(taskId);
      activeProvider = null;

      await assertContainerRemoved(docker, containerName);
    } catch (err) {
      if (isDockerDnsFailure(err)) {
        throw new Error(
          `AIO provider e2e could not reach ${containerName} by Docker DNS. ` +
            `Run this suite from a container attached to AIO_SANDBOX_NETWORK, ` +
            `with docker.sock mounted; original error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      throw err;
    } finally {
      if (activeProvider) {
        await activeProvider.removeSandbox(taskId).catch(() => undefined);
      }
      await forceRemoveContainer(docker, containerName);
    }
  },
);

function createProvider(docker) {
  const controller = new mod.AioSandboxContainerController({
    docker,
    env: process.env,
    delay,
  });
  const provider = new mod.AioSandboxProvider({
    controller,
    hooks: {
      provisionLookup: {
        getRuntimeId: () => 'codex',
      },
      runtimePreflight: async ({ executor, runtimeId }) => {
        const result = await executor.exec({
          command: 'command -v sh >/dev/null && command -v tmux >/dev/null',
          timeoutMs: 15_000,
        });
        if (result.exitCode !== 0) {
          return {
            status: 'failed',
            checkedAt: new Date().toISOString(),
            runtimeId: runtimeId ?? undefined,
            error: `AIO image is missing required shell/tmux tools: ${result.output}`,
          };
        }
        return {
          status: 'passed',
          checkedAt: new Date().toISOString(),
          runtimeId: runtimeId ?? undefined,
        };
      },
      runtimeSetup: async ({ executor, workspaceDir }) => {
        const result = await executor.exec({
          command: `mkdir -p ${shellQuote(workspaceDir)}`,
          timeoutMs: 15_000,
        });
        if (result.exitCode !== 0) {
          throw new Error(`workspace setup failed: ${result.output}`);
        }
      },
      preStopTrim: async ({ executor }) => {
        await executor.exec({
          command: ': > /home/gem/.codex/auth.json 2>/dev/null; true',
          timeoutMs: 10_000,
        });
      },
    },
  });
  return { controller, provider };
}

async function loadDocker() {
  try {
    const imported = await import('dockerode');
    return imported.default;
  } catch (err) {
    throw new Error(
      `AIO_PROVIDER_E2E=1 requires dockerode to be installed for @cap/sandbox-provider-aio: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function assertAioPrerequisites(docker) {
  if (!process.env.AIO_SANDBOX_IMAGE) {
    throw new Error('AIO_PROVIDER_E2E=1 requires AIO_SANDBOX_IMAGE to be set to a pinned local image');
  }
  await docker.ping().catch((err) => {
    throw new Error(
      `AIO_PROVIDER_E2E=1 requires Docker daemon access: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
  await docker.getImage(process.env.AIO_SANDBOX_IMAGE).inspect().catch((err) => {
    throw new Error(
      `AIO_SANDBOX_IMAGE=${process.env.AIO_SANDBOX_IMAGE} is not available locally: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });

  const network = process.env.AIO_SANDBOX_NETWORK ?? mod.AIO_SANDBOX_DEFAULT_NETWORK;
  await docker.getNetwork(network).inspect().catch((err) => {
    throw new Error(
      `AIO_SANDBOX_NETWORK=${network} does not exist. Create it and run this test from a runner attached to that network: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
}

async function assertContainerRemoved(docker, containerName) {
  try {
    await docker.getContainer(containerName).inspect();
  } catch {
    return;
  }
  throw new Error(`AIO e2e container ${containerName} still exists after cleanup`);
}

async function forceRemoveContainer(docker, containerName) {
  await docker.getContainer(containerName).remove({ force: true }).catch(() => undefined);
}

function isDockerDnsFailure(err) {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('fetch failed') ||
    message.includes('getaddrinfo') ||
    message.includes('ENOTFOUND') ||
    message.includes('did not become ready')
  );
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
