import assert from 'node:assert/strict';
import test from 'node:test';
import { Duplex } from 'node:stream';
import Docker from 'dockerode';
import { Test } from '@nestjs/testing';

import {
  CODEX_APP_SERVER_ARGV,
  CODEX_LOGIN_COMPONENT_LABEL,
  CODEX_LOGIN_COMPONENT_VALUE,
  CODEX_LOGIN_NUMERIC_USER,
  CODEX_LOGIN_SESSION_LABEL,
  DockerCodexDeviceLoginRunner,
  summarizeRedactedStderrForTest,
} from './docker-codex-device-login-runner';
import {
  CODEX_DEVICE_LOGIN_RUNNER,
  CodexDeviceLoginRunnerError,
} from './codex-device-login-runner';

type JsonMessage = Record<string, unknown>;

function dockerFrame(streamType: 1 | 2, payload: Buffer | string): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.alloc(8);
  header.writeUInt8(streamType, 0);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

class FakeHijackedStream extends Duplex {
  private input = '';
  readonly requests: JsonMessage[] = [];
  onRequest?: (message: JsonMessage) => void;

  override _read(): void {}

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.input += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk.toString();
    let newline: number;
    while ((newline = this.input.indexOf('\n')) !== -1) {
      const line = this.input.slice(0, newline);
      this.input = this.input.slice(newline + 1);
      if (!line) continue;
      const request = JSON.parse(line) as JsonMessage;
      this.requests.push(request);
      this.onRequest?.(request);
    }
    callback();
  }

  sendStdout(message: JsonMessage, fragmented = false): void {
    const line = Buffer.from(`${JSON.stringify(message)}\n`);
    if (!fragmented) {
      this.push(dockerFrame(1, line));
      return;
    }
    const split = Math.max(1, Math.floor(line.length / 2));
    const first = dockerFrame(1, line.subarray(0, split));
    const second = dockerFrame(1, line.subarray(split));
    // Fragment the first Docker header and coalesce its remainder with the next
    // frame, exercising both Docker framing and incremental JSONL decoding.
    this.push(first.subarray(0, 5));
    this.push(Buffer.concat([first.subarray(5), second]));
  }

  sendStdoutCoalesced(messages: readonly JsonMessage[]): void {
    const body = messages.map((message) => JSON.stringify(message)).join('\n') + '\n';
    this.push(dockerFrame(1, body));
  }

  sendStderr(value: string): void {
    this.push(dockerFrame(2, value));
  }

  sendRawStdout(value: string): void {
    this.push(dockerFrame(1, value));
  }

  exit(): void {
    this.push(null);
  }
}

interface FakeEnvironmentOptions {
  readonly imageAvailable?: boolean;
  readonly blockContainerStart?: boolean;
  readonly blockContainerStop?: boolean;
  readonly blockContainerRemove?: boolean;
  readonly blockContainerRemoveAttempts?: number;
  readonly conflictContainerRemoveAttempts?: number;
  readonly containerAbsentAfterInspects?: number;
  readonly respondInitialize?: boolean;
  readonly sendCompletion?: boolean;
  readonly credential?: string;
  readonly invalidInitialize?: 'malformed' | 'oversized';
}

function makeFakeEnvironment(options: FakeEnvironmentOptions = {}) {
  const modem = new Docker().modem;
  const appStream = new FakeHijackedStream();
  const execOptions: Docker.ExecCreateOptions[] = [];
  const lifecycle = { created: 0, started: 0, stopped: 0, removed: 0, inspected: 0 };
  const directResults: Array<{ argv: string[]; stdout: string }> = [];
  let containerPresent = true;

  const container = {
    start: async (startOptions?: Docker.ContainerStartOptions) => {
      lifecycle.started += 1;
      if (options.blockContainerStart) {
        await new Promise<never>((_resolve, reject) => {
          if (startOptions?.abortSignal?.aborted) {
            reject(new Error('aborted'));
            return;
          }
          startOptions?.abortSignal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        });
      }
    },
    stop: async (
      stopOptions?: Docker.ContainerStopOptions,
    ) => {
      lifecycle.stopped += 1;
      if (options.blockContainerStop) {
        await new Promise<never>((_resolve, reject) => {
          stopOptions?.abortSignal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        });
      }
    },
    remove: async (
      removeOptions?: Docker.ContainerRemoveOptions & { abortSignal?: AbortSignal },
    ) => {
      lifecycle.removed += 1;
      if (
        lifecycle.removed <= (options.conflictContainerRemoveAttempts ?? 0)
      ) {
        throw Object.assign(new Error('container removal conflict'), {
          statusCode: 409,
        });
      }
      if (
        options.blockContainerRemove ||
        lifecycle.removed <= (options.blockContainerRemoveAttempts ?? 0)
      ) {
        await new Promise<never>((_resolve, reject) => {
          removeOptions?.abortSignal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        });
      }
      containerPresent = false;
    },
    inspect: async () => {
      lifecycle.inspected += 1;
      const absentAfter = options.containerAbsentAfterInspects;
      if (
        !containerPresent ||
        (absentAfter !== undefined && lifecycle.inspected > absentAfter)
      ) {
        throw Object.assign(new Error('container not found'), { statusCode: 404 });
      }
      return { Id: 'fake-container' };
    },
    exec: async (execOption: Docker.ExecCreateOptions) => {
      execOptions.push(execOption);
      const argv = execOption.Cmd ?? [];
      const isAppServer = argv[0] === 'codex' && argv[1] === 'app-server';
      if (isAppServer) {
        return {
          start: async () => appStream,
          inspect: async () => ({ Running: true, ExitCode: null }),
        };
      }

      const stdout =
        argv[0] === 'codex'
          ? 'codex-cli 0.144.1\n'
          : argv[0] === 'cat'
            ? (options.credential ?? '{"auth_mode":"chatgpt","tokens":{"access_token":"x"}}')
            : '';
      directResults.push({ argv: [...argv], stdout });
      const raw = new FakeHijackedStream();
      return {
        start: async () => {
          queueMicrotask(() => {
            if (stdout) raw.push(dockerFrame(1, stdout));
            raw.exit();
          });
          return raw;
        },
        inspect: async () => ({ Running: false, ExitCode: 0 }),
      };
    },
  } as unknown as Docker.Container;

  const createdOptions: Docker.ContainerCreateOptions[] = [];
  const docker = {
    modem,
    getImage: () => ({
      inspect: async () => {
        if (options.imageAvailable === false) throw new Error('No such image: secret-ref');
        return { Id: 'sha256:pinned' };
      },
    }),
    createContainer: async (createOptions: Docker.ContainerCreateOptions) => {
      lifecycle.created += 1;
      createdOptions.push(createOptions);
      return container;
    },
    listContainers: async () => [],
    getContainer: () => container,
  } as unknown as Docker;

  appStream.onRequest = (request) => {
    if (request.method === 'initialize' && options.respondInitialize !== false) {
      appStream.sendStderr('Bearer should-never-reach-jsonl\n');
      if (options.invalidInitialize === 'malformed') {
        appStream.sendRawStdout('{"access_token":"must-not-leak"\n');
        return;
      }
      if (options.invalidInitialize === 'oversized') {
        appStream.sendRawStdout('x'.repeat(65));
        return;
      }
      appStream.sendStdout(
        {
          id: request.id,
          result: {
            codexHome: '/home/gem/.codex',
            platformFamily: 'unix',
            platformOs: 'linux',
            userAgent: 'codex_cli_rs/0.144.1',
          },
        },
        true,
      );
    } else if (request.method === 'account/login/start') {
      const response = {
        id: request.id,
        result: {
          type: 'chatgptDeviceCode',
          loginId: 'login-1',
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: 'ABCD-1234',
        },
      };
      if (options.sendCompletion === false) {
        appStream.sendStdout(response, true);
      } else {
        appStream.sendStdoutCoalesced([
          response,
          { method: 'new/unknown-notification', params: { value: true } },
          {
            method: 'account/login/completed',
            params: { loginId: 'stale-login', success: true, error: null },
          },
          {
            method: 'account/login/completed',
            params: { loginId: 'login-1', success: true, error: null },
          },
        ]);
      }
    } else if (request.method === 'account/login/cancel') {
      appStream.sendStdout({ id: request.id, result: { status: 'canceled' } });
    }
  };

  return {
    docker,
    container,
    appStream,
    execOptions,
    lifecycle,
    directResults,
    createdOptions,
  };
}

function runnerError(category: CodexDeviceLoginRunnerError['category']) {
  return (error: unknown): boolean =>
    error instanceof CodexDeviceLoginRunnerError && error.category === category;
}

test('Nest can bind the concrete runner behind the injectable port token', async () => {
  const moduleRef = await Test.createTestingModule({
    providers: [
      DockerCodexDeviceLoginRunner,
      {
        provide: CODEX_DEVICE_LOGIN_RUNNER,
        useExisting: DockerCodexDeviceLoginRunner,
      },
    ],
  }).compile();
  assert.equal(
    moduleRef.get(CODEX_DEVICE_LOGIN_RUNNER),
    moduleRef.get(DockerCodexDeviceLoginRunner),
  );
  await moduleRef.close();
});

test('Docker runner uses pinned non-TTY stdio argv, labels, demux and structured completion', async () => {
  const fake = makeFakeEnvironment();
  const runner = new DockerCodexDeviceLoginRunner(fake.docker, {
    image: 'cap-aio:pinned',
    protocolRequestTimeoutMs: 500,
  });
  const handle = await runner.start({ sessionId: 'session-1' });

  assert.deepEqual(handle.authorization, {
    loginId: 'login-1',
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: 'ABCD-1234',
  });
  assert.deepEqual(await handle.waitForCompletion(), {
    loginId: 'login-1',
    success: true,
  });

  const appExec = fake.execOptions.find((option) => option.Cmd?.[1] === 'app-server');
  assert.ok(appExec);
  assert.deepEqual(appExec.Cmd, [...CODEX_APP_SERVER_ARGV]);
  assert.equal(appExec.Tty, false);
  assert.equal(appExec.User, CODEX_LOGIN_NUMERIC_USER);
  assert.ok(appExec.Env?.includes('HOME=/home/gem'));
  assert.ok(appExec.Env?.includes('CODEX_HOME=/home/gem/.codex'));
  assert.deepEqual(
    fake.appStream.requests.map((request) => request.method),
    ['initialize', 'initialized', 'account/login/start'],
  );

  const create = fake.createdOptions[0];
  assert.equal(create.Labels?.[CODEX_LOGIN_COMPONENT_LABEL], CODEX_LOGIN_COMPONENT_VALUE);
  assert.equal(create.Labels?.[CODEX_LOGIN_SESSION_LABEL], 'session-1');
  assert.equal(fake.lifecycle.created, 1);
  assert.equal(fake.lifecycle.started, 1);
  await handle.dispose();
});

test('reads auth.json through a bounded direct exec and cancellation/disposal are repeatable', async () => {
  const credential = '{"auth_mode":"chatgpt","tokens":{"access_token":"secret"}}';
  const fake = makeFakeEnvironment({ credential });
  const runner = new DockerCodexDeviceLoginRunner(fake.docker, {
    image: 'cap-aio:pinned',
    protocolRequestTimeoutMs: 500,
  });
  const handle = await runner.start({ sessionId: 'session-2' });

  assert.equal(await handle.readCredential(), credential);
  assert.ok(
    fake.directResults.some(
      (result) => result.argv[0] === 'cat' && result.argv[1] === '/home/gem/.codex/auth.json',
    ),
  );

  await Promise.all([handle.cancel(), handle.cancel(), handle.dispose(), handle.dispose()]);
  assert.equal(
    fake.appStream.requests.filter((request) => request.method === 'account/login/cancel').length,
    1,
  );
  assert.equal(fake.lifecycle.stopped, 1);
  assert.equal(fake.lifecycle.removed, 1);
});

test('classifies missing images before container creation without leaking Docker errors', async () => {
  const fake = makeFakeEnvironment({ imageAvailable: false });
  const runner = new DockerCodexDeviceLoginRunner(fake.docker, { image: 'missing:secret-tag' });
  await assert.rejects(
    runner.start({ sessionId: 'session-image' }),
    (error: unknown) => {
      assert.ok(runnerError('device_login_worker_image_unavailable')(error));
      assert.doesNotMatch((error as Error).message, /missing:secret-tag|No such image/);
      return true;
    },
  );
  assert.equal(fake.lifecycle.created, 0);
});

test('maps malformed and oversized Docker-framed JSONL to a redacted protocol category', async (t) => {
  for (const invalidInitialize of ['malformed', 'oversized'] as const) {
    await t.test(invalidInitialize, async () => {
      const fake = makeFakeEnvironment({ invalidInitialize });
      const runner = new DockerCodexDeviceLoginRunner(fake.docker, {
        image: 'cap-aio:pinned',
        protocolMaxLineBytes: 64,
        protocolRequestTimeoutMs: 500,
      });
      await assert.rejects(
        runner.start({ sessionId: `session-${invalidInitialize}` }),
        (error: unknown) => {
          assert.ok(runnerError('device_login_protocol_invalid')(error));
          assert.doesNotMatch((error as Error).message, /access_token|must-not-leak/);
          return true;
        },
      );
      assert.equal(fake.lifecycle.stopped, 1);
      assert.equal(fake.lifecycle.removed, 1);
    });
  }
});

test('enforces credential byte limits and never includes credential content in errors', async () => {
  const fake = makeFakeEnvironment({ credential: 'top-secret-credential'.repeat(8) });
  const runner = new DockerCodexDeviceLoginRunner(fake.docker, {
    image: 'cap-aio:pinned',
    credentialMaxBytes: 16,
    protocolRequestTimeoutMs: 500,
  });
  const handle = await runner.start({ sessionId: 'session-large-credential' });
  await assert.rejects(handle.readCredential(), (error: unknown) => {
    assert.ok(runnerError('device_login_credential_too_large')(error));
    assert.doesNotMatch((error as Error).message, /top-secret-credential/);
    return true;
  });
  await handle.dispose();
});

test('maps App Server exit, timeout and caller abort to stable categories and cleans up', async (t) => {
  await t.test('process exit after device-code issuance', async () => {
    const fake = makeFakeEnvironment({ sendCompletion: false });
    const runner = new DockerCodexDeviceLoginRunner(fake.docker, {
      image: 'cap-aio:pinned',
      protocolRequestTimeoutMs: 500,
    });
    const handle = await runner.start({ sessionId: 'session-exit' });
    const completion = handle.waitForCompletion();
    fake.appStream.exit();
    await assert.rejects(completion, runnerError('device_login_worker_exited'));
    await handle.dispose();
  });

  await t.test('initialize timeout', async () => {
    const fake = makeFakeEnvironment({ respondInitialize: false });
    const runner = new DockerCodexDeviceLoginRunner(fake.docker, {
      image: 'cap-aio:pinned',
      protocolRequestTimeoutMs: 10,
    });
    await assert.rejects(
      runner.start({ sessionId: 'session-timeout' }),
      runnerError('device_login_protocol_timeout'),
    );
    assert.equal(fake.lifecycle.stopped, 1);
    assert.equal(fake.lifecycle.removed, 1);
  });

  await t.test('AbortSignal during initialize', async () => {
    const fake = makeFakeEnvironment({ respondInitialize: false });
    const runner = new DockerCodexDeviceLoginRunner(fake.docker, {
      image: 'cap-aio:pinned',
      protocolRequestTimeoutMs: 500,
    });
    const controller = new AbortController();
    const starting = runner.start({ sessionId: 'session-abort', signal: controller.signal });
    setImmediate(() => controller.abort());
    await assert.rejects(starting, runnerError('device_login_cancelled'));
    assert.equal(fake.lifecycle.stopped, 1);
    assert.equal(fake.lifecycle.removed, 1);
  });

  await t.test('AbortSignal reaches an in-flight Docker start and reclaims its container', async () => {
    const fake = makeFakeEnvironment({ blockContainerStart: true });
    const runner = new DockerCodexDeviceLoginRunner(fake.docker, {
      image: 'cap-aio:pinned',
      stageTimeoutMs: 500,
    });
    const controller = new AbortController();
    const starting = runner.start({
      sessionId: 'session-docker-abort',
      signal: controller.signal,
    });
    setImmediate(() => controller.abort());
    await assert.rejects(starting, runnerError('device_login_cancelled'));
    assert.equal(fake.lifecycle.created, 1);
    assert.equal(fake.lifecycle.stopped, 1);
    assert.equal(fake.lifecycle.removed, 1);
  });
});

test('stderr diagnostics are bounded and fully redacted', () => {
  const summary = summarizeRedactedStderrForTest(
    [Buffer.from('Bearer access-secret ABCD-1234 and more bytes')],
    12,
  );
  assert.match(summary, /^\[stderr redacted; bytes=\d+; truncated=true\]$/);
  assert.doesNotMatch(summary, /access-secret|ABCD-1234|Bearer/);
});

test('dispose remains bounded when Docker stop hangs and force-remove is the fallback', async () => {
  const fake = makeFakeEnvironment({ blockContainerStop: true });
  const runner = new DockerCodexDeviceLoginRunner(fake.docker, {
    image: 'cap-aio:pinned',
    stageTimeoutMs: 30,
    protocolRequestTimeoutMs: 500,
  });
  const handle = await runner.start({ sessionId: 'session-stop-hangs' });
  await handle.dispose();
  assert.equal(fake.lifecycle.stopped, 1);
  assert.equal(fake.lifecycle.removed, 1);
});

test('failed dispose can retry, while the first successful cleanup remains idempotent', async () => {
  const fake = makeFakeEnvironment({ blockContainerRemoveAttempts: 2 });
  const runner = new DockerCodexDeviceLoginRunner(fake.docker, {
    image: 'cap-aio:pinned',
    stageTimeoutMs: 30,
    protocolRequestTimeoutMs: 500,
  });
  const handle = await runner.start({ sessionId: 'session-remove-hangs' });
  await assert.rejects(
    handle.dispose(),
    runnerError('device_login_worker_cleanup_failed'),
  );
  assert.equal(fake.lifecycle.removed, 2, 'the first cleanup exhausts two bounded attempts');

  await handle.dispose();
  assert.equal(fake.lifecycle.removed, 3, 'the next explicit dispose retries and succeeds');

  await handle.dispose();
  assert.equal(fake.lifecycle.removed, 3, 'cleanup stays idempotent after the first success');
});

test('dispose accepts a 409 remove race only after inspect confirms the container is absent', async () => {
  const fake = makeFakeEnvironment({
    conflictContainerRemoveAttempts: 1,
    containerAbsentAfterInspects: 0,
  });
  const runner = new DockerCodexDeviceLoginRunner(fake.docker, {
    image: 'cap-aio:pinned',
    protocolRequestTimeoutMs: 500,
    stageTimeoutMs: 100,
  });
  const handle = await runner.start({ sessionId: 'session-auto-remove-race' });

  await handle.dispose();

  assert.equal(fake.lifecycle.removed, 1);
  assert.equal(fake.lifecycle.inspected, 1);
});

test('dispose retries a 409 remove conflict while the container still exists', async () => {
  const fake = makeFakeEnvironment({ conflictContainerRemoveAttempts: 1 });
  const runner = new DockerCodexDeviceLoginRunner(fake.docker, {
    image: 'cap-aio:pinned',
    protocolRequestTimeoutMs: 500,
    stageTimeoutMs: 60,
  });
  const handle = await runner.start({ sessionId: 'session-remove-conflict-retry' });

  await handle.dispose();

  assert.equal(fake.lifecycle.removed, 2);
  assert.ok(fake.lifecycle.inspected >= 1);
});

test('dispose rejects when repeated 409 conflicts leave the container present', async () => {
  const fake = makeFakeEnvironment({ conflictContainerRemoveAttempts: 2 });
  const runner = new DockerCodexDeviceLoginRunner(fake.docker, {
    image: 'cap-aio:pinned',
    protocolRequestTimeoutMs: 500,
    stageTimeoutMs: 60,
  });
  const handle = await runner.start({ sessionId: 'session-remove-conflict-fails' });

  await assert.rejects(
    handle.dispose(),
    runnerError('device_login_worker_cleanup_failed'),
  );
  assert.equal(fake.lifecycle.removed, 2);
  assert.ok(fake.lifecycle.inspected >= 2);
});

test('disposeOrphans filters by the stable ownership label and removes every match', async () => {
  const fake = makeFakeEnvironment();
  const filters: unknown[] = [];
  (fake.docker.listContainers as unknown as (options: unknown) => Promise<unknown>) = async (
    options,
  ) => {
    filters.push(options);
    return [{ Id: 'orphan-1' }, { Id: 'orphan-2' }];
  };
  await new DockerCodexDeviceLoginRunner(fake.docker, {
    image: 'cap-aio:pinned',
  }).disposeOrphans();
  assert.deepEqual(
    (filters[0] as { filters: { label: string[] } }).filters.label,
    [`${CODEX_LOGIN_COMPONENT_LABEL}=${CODEX_LOGIN_COMPONENT_VALUE}`],
  );
  assert.equal(fake.lifecycle.stopped, 2);
  assert.equal(fake.lifecycle.removed, 2);
});

test('disposeOrphans is deadline-bounded and aborts its Docker list operation', async () => {
  const fake = makeFakeEnvironment();
  let observedAbort = false;
  (fake.docker.listContainers as unknown as (
    options: Docker.ContainerListOptions,
  ) => Promise<unknown>) = async (options) =>
    new Promise((_resolve, reject) => {
      options.abortSignal?.addEventListener(
        'abort',
        () => {
          observedAbort = true;
          reject(new Error('aborted'));
        },
        { once: true },
      );
    });
  const runner = new DockerCodexDeviceLoginRunner(fake.docker, {
    image: 'cap-aio:pinned',
    stageTimeoutMs: 10,
  });
  await assert.rejects(
    runner.disposeOrphans(),
    runnerError('device_login_worker_start_failed'),
  );
  assert.equal(observedAbort, true);
});
