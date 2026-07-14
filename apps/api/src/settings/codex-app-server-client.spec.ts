import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';

import {
  CodexAppServerClient,
  CodexAppServerClientError,
} from './codex-app-server-client';

type Message = Record<string, unknown>;

class ProtocolHarness {
  readonly fromServer = new PassThrough();
  readonly toServer = new PassThrough();
  readonly messages: Message[] = [];
  onMessage?: (message: Message) => void;
  private input = '';

  constructor() {
    this.toServer.setEncoding('utf8');
    this.toServer.on('data', (chunk: string) => {
      this.input += chunk;
      let newline: number;
      while ((newline = this.input.indexOf('\n')) !== -1) {
        const line = this.input.slice(0, newline);
        this.input = this.input.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line) as Message;
        this.messages.push(message);
        this.onMessage?.(message);
      }
    });
  }

  send(message: Message, splitAt?: number): void {
    const line = Buffer.from(`${JSON.stringify(message)}\n`);
    if (splitAt === undefined) {
      this.fromServer.write(line);
      return;
    }
    this.fromServer.write(line.subarray(0, splitAt));
    this.fromServer.write(line.subarray(splitAt));
  }

  sendCoalesced(messages: readonly Message[]): void {
    this.fromServer.write(messages.map((message) => JSON.stringify(message)).join('\n') + '\n');
  }
}

const INITIALIZE_RESULT = {
  codexHome: '/home/gem/.codex',
  platformFamily: 'unix',
  platformOs: 'linux',
  userAgent: 'codex_cli_rs/0.144.1',
};

function model(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'preset-id',
    model: 'provider/model-selector',
    displayName: 'Model Selector',
    description: 'Fixture model',
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [],
    ...overrides,
  };
}

function isClientError(kind: CodexAppServerClientError['kind']): (error: unknown) => boolean {
  return (error) => error instanceof CodexAppServerClientError && error.kind === kind;
}

test('performs initialize -> initialized -> device start and correlates fragmented responses', async () => {
  const harness = new ProtocolHarness();
  const client = new CodexAppServerClient(
    { readable: harness.fromServer, writable: harness.toServer },
    { requestTimeoutMs: 500 },
  );
  harness.onMessage = (message) => {
    if (message.method === 'initialize') {
      harness.send({ id: message.id, result: INITIALIZE_RESULT }, 7);
    }
    if (message.method === 'account/login/start') {
      // The response, an unknown notification, a stale completion and the
      // matching completion are deliberately coalesced into one read.
      harness.sendCoalesced([
        {
          id: message.id,
          result: {
            type: 'chatgptDeviceCode',
            loginId: 'login-current',
            verificationUrl: 'https://auth.openai.com/codex/device',
            userCode: 'ABCD-1234',
          },
        },
        { method: 'future/notification', params: { ignored: true } },
        {
          method: 'account/login/completed',
          params: { success: false, error: null },
        },
        {
          method: 'account/login/completed',
          params: { loginId: 'login-stale', success: true, error: null },
        },
        {
          method: 'account/login/completed',
          params: { loginId: 'login-current', success: true, error: null },
        },
      ]);
    }
  };

  await client.initialize();
  const authorization = await client.startDeviceCode();
  assert.deepEqual(authorization, {
    loginId: 'login-current',
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: 'ABCD-1234',
  });
  assert.deepEqual(await client.waitForCompletion('login-current'), {
    loginId: 'login-current',
    success: true,
  });
  assert.deepEqual(
    harness.messages.map((message) => message.method),
    ['initialize', 'initialized', 'account/login/start'],
    'initialized must be sent only after the initialize response',
  );
});

test('sends account/login/cancel with the exact login id and accepts notFound', async () => {
  const harness = new ProtocolHarness();
  const client = new CodexAppServerClient({
    readable: harness.fromServer,
    writable: harness.toServer,
  });
  harness.onMessage = (message) => {
    if (message.method === 'initialize') {
      harness.send({ id: message.id, result: INITIALIZE_RESULT });
    } else if (message.method === 'account/login/cancel') {
      harness.send({ id: message.id, result: { status: 'notFound' } });
    }
  };

  await client.initialize();
  await client.cancel('login-to-cancel');
  const cancel = harness.messages.find(
    (message) => message.method === 'account/login/cancel',
  );
  assert.deepEqual(cancel?.params, { loginId: 'login-to-cancel' });
});

test('lists visible models across bounded pages using the protocol model selector, not preset id', async () => {
  const harness = new ProtocolHarness();
  const client = new CodexAppServerClient(
    { readable: harness.fromServer, writable: harness.toServer },
    { requestTimeoutMs: 500 },
  );
  harness.onMessage = (message) => {
    if (message.method === 'initialize') {
      harness.send({ id: message.id, result: INITIALIZE_RESULT });
    } else if (message.method === 'model/list') {
      const cursor = (message.params as { cursor?: unknown }).cursor;
      harness.send({
        id: message.id,
        result:
          cursor === null
            ? {
                data: [
                  model(),
                  model({
                    id: 'hidden-preset',
                    model: 'hidden-selector',
                    displayName: 'Hidden',
                    hidden: true,
                  }),
                ],
                nextCursor: 'page-2',
              }
            : {
                data: [
                  model({
                    id: 'preset-2',
                    model: 'selector-2',
                    displayName: 'Second',
                    isDefault: true,
                  }),
                ],
                nextCursor: null,
              },
      });
    }
  };

  await client.initialize();
  assert.deepEqual(await client.listAllModels(), [
    {
      id: 'preset-id',
      model: 'provider/model-selector',
      displayName: 'Model Selector',
      hidden: false,
      isDefault: false,
    },
    {
      id: 'preset-2',
      model: 'selector-2',
      displayName: 'Second',
      hidden: false,
      isDefault: true,
    },
  ]);
  assert.deepEqual(
    harness.messages
      .filter((message) => message.method === 'model/list')
      .map((message) => message.params),
    [
      { cursor: null, limit: 100, includeHidden: false },
      { cursor: 'page-2', limit: 100, includeHidden: false },
    ],
  );
});

test('model listing rejects malformed protocol items and repeated cursors', async (t) => {
  await t.test('malformed item', async () => {
    const harness = new ProtocolHarness();
    const client = new CodexAppServerClient({
      readable: harness.fromServer,
      writable: harness.toServer,
    });
    harness.onMessage = (message) => {
      if (message.method === 'initialize') {
        harness.send({ id: message.id, result: INITIALIZE_RESULT });
      } else if (message.method === 'model/list') {
        harness.send({
          id: message.id,
          result: { data: [model({ model: '' })], nextCursor: null },
        });
      }
    };
    await client.initialize();
    await assert.rejects(client.listAllModels(), isClientError('malformed_message'));
  });

  await t.test('repeated cursor', async () => {
    const harness = new ProtocolHarness();
    const client = new CodexAppServerClient({
      readable: harness.fromServer,
      writable: harness.toServer,
    });
    harness.onMessage = (message) => {
      if (message.method === 'initialize') {
        harness.send({ id: message.id, result: INITIALIZE_RESULT });
      } else if (message.method === 'model/list') {
        harness.send({
          id: message.id,
          result: { data: [], nextCursor: 'same-cursor' },
        });
      }
    };
    await client.initialize();
    await assert.rejects(client.listAllModels(), isClientError('malformed_message'));
  });
});

test('rejects malformed and oversized JSONL without echoing protocol contents', async (t) => {
  await t.test('malformed JSON', async () => {
    const harness = new ProtocolHarness();
    const client = new CodexAppServerClient({
      readable: harness.fromServer,
      writable: harness.toServer,
    });
    const initializing = client.initialize();
    harness.fromServer.write('{"access_token":"must-not-leak"\n');
    await assert.rejects(initializing, (error: unknown) => {
      assert.ok(isClientError('malformed_message')(error));
      assert.doesNotMatch((error as Error).message, /must-not-leak|access_token/);
      return true;
    });
  });

  await t.test('oversized line', async () => {
    const harness = new ProtocolHarness();
    const client = new CodexAppServerClient(
      { readable: harness.fromServer, writable: harness.toServer },
      { maxLineBytes: 32 },
    );
    const initializing = client.initialize();
    harness.fromServer.write('x'.repeat(33));
    await assert.rejects(initializing, isClientError('message_too_large'));
  });
});

test('rejects process exit, request timeout and AbortSignal cancellation with stable errors', async (t) => {
  await t.test('process exit', async () => {
    const harness = new ProtocolHarness();
    const client = new CodexAppServerClient({
      readable: harness.fromServer,
      writable: harness.toServer,
    });
    const initializing = client.initialize();
    harness.fromServer.end();
    await assert.rejects(initializing, isClientError('process_exited'));
  });

  await t.test('timeout', async () => {
    const harness = new ProtocolHarness();
    const client = new CodexAppServerClient(
      { readable: harness.fromServer, writable: harness.toServer },
      { requestTimeoutMs: 10 },
    );
    await assert.rejects(client.initialize(), isClientError('request_timeout'));
  });

  await t.test('abort', async () => {
    const harness = new ProtocolHarness();
    const client = new CodexAppServerClient({
      readable: harness.fromServer,
      writable: harness.toServer,
    });
    const controller = new AbortController();
    const initializing = client.initialize({ signal: controller.signal });
    controller.abort();
    await assert.rejects(initializing, isClientError('aborted'));
  });
});

test('rejects malformed known responses and discards server error text', async (t) => {
  await t.test('malformed initialize result', async () => {
    const harness = new ProtocolHarness();
    const client = new CodexAppServerClient({
      readable: harness.fromServer,
      writable: harness.toServer,
    });
    harness.onMessage = (message) => {
      if (message.method === 'initialize') harness.send({ id: message.id, result: {} });
    };
    await assert.rejects(client.initialize(), isClientError('malformed_message'));
  });

  await t.test('JSON-RPC error redaction', async () => {
    const harness = new ProtocolHarness();
    const client = new CodexAppServerClient({
      readable: harness.fromServer,
      writable: harness.toServer,
    });
    harness.onMessage = (message) => {
      if (message.method === 'initialize') {
        harness.send({
          id: message.id,
          error: { code: -32_000, message: 'Bearer secret-token-value' },
        });
      }
    };
    await assert.rejects(client.initialize(), (error: unknown) => {
      assert.ok(isClientError('request_failed')(error));
      assert.doesNotMatch((error as Error).message, /secret-token-value|Bearer/);
      return true;
    });
  });

  await t.test('malformed known completion notification', async () => {
    const harness = new ProtocolHarness();
    const client = new CodexAppServerClient({
      readable: harness.fromServer,
      writable: harness.toServer,
    });
    harness.onMessage = (message) => {
      if (message.method === 'initialize') {
        harness.send({ id: message.id, result: INITIALIZE_RESULT });
      } else if (message.method === 'account/login/start') {
        harness.send({
          id: message.id,
          result: {
            type: 'chatgptDeviceCode',
            loginId: 'login-malformed-completion',
            verificationUrl: 'https://auth.openai.com/codex/device',
            userCode: 'ABCD-1234',
          },
        });
      }
    };
    await client.initialize();
    const authorization = await client.startDeviceCode();
    const completion = client.waitForCompletion(authorization.loginId);
    harness.send({
      method: 'account/login/completed',
      params: { loginId: authorization.loginId },
    });
    await assert.rejects(completion, isClientError('malformed_message'));
  });
});
