import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createCipheriv, createHash } from 'node:crypto';

const mod = await import(new URL('../dist/index.js', import.meta.url).href);

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

function unwrapSingleQuotedShLc(command) {
  const prefix = "sh -lc '";
  assert.ok(command.startsWith(prefix) && command.endsWith("'"));
  return command.slice(prefix.length, -1).replaceAll("'\\''", "'");
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function scope(overrides = {}) {
  return {
    taskId: 'task-journal-secret',
    providerSandboxId: 'provider-sandbox-secret',
    ownership: {
      ownerGeneration: 'owner-generation-secret',
      resourceGeneration: 'resource-generation-secret',
    },
    ...overrides,
  };
}

const TEST_BOOT_ID = '11111111-1111-4111-8111-111111111111';

function canonicalProviderSessionId(slot) {
  const prefix = Number(slot).toString(16).padStart(8, '0');
  const suffix = Number(slot).toString(16).padStart(12, '0');
  return `${prefix}-0000-4000-8000-${suffix}`;
}

function guestFingerprint(slot) {
  const pid = String(10_000 + slot);
  return {
    tty: `/dev/pts/${slot}`,
    pid,
    sid: pid,
    pgid: pid,
    startTime: `${pid}00`,
    bootId: TEST_BOOT_ID,
  };
}

function ownershipPair({
  mainSessionId = '11111111-1111-4111-8111-111111111111',
  injectorSessionId = '22222222-2222-4222-8222-222222222222',
  slot = 11,
  closeNonce = 'pair00000001',
} = {}) {
  return {
    mainSessionId,
    injectorSessionId,
    main: guestFingerprint(slot),
    injector: guestFingerprint(slot + 1),
    closeToken: `: CAP_AIO_INJECTOR_CLOSE_${closeNonce}`,
    releaseMarker: `CAP_AIO_INJECTOR_RELEASED_${closeNonce}`,
  };
}

function ownershipRecord({
  providerSessionId,
  mainSessionId,
  injectorSessionId,
  pair,
  ownershipScope = scope(),
  processFingerprint,
  role = 'main',
  ivByte = 1,
}) {
  const pairedSessionId = canonicalProviderSessionId(500 + ivByte);
  const legacyMainSessionId =
    role === 'injector'
      ? pairedSessionId
      : providerSessionId;
  const legacyInjectorSessionId =
    role === 'injector'
      ? providerSessionId
      : pairedSessionId;
  return mod.createAioTerminalOwnershipRecord({
    pair:
      pair ??
      ownershipPair({
        mainSessionId: mainSessionId ?? legacyMainSessionId,
        injectorSessionId: injectorSessionId ?? legacyInjectorSessionId,
        slot: 20 + ivByte * 2,
        closeNonce: `pair${String(ivByte).padStart(8, '0')}`,
      }),
    scope: ownershipScope,
    processFingerprint,
    iv: Uint8Array.from({ length: 12 }, () => ivByte),
  });
}

const confirmedGuestPairReleaser = async () => ({
  kind: 'confirmed',
  cause: null,
});

class FakeReconnectSocket {
  readyState = 1;
  listeners = new Map();
  sent = [];
  terminated = false;
  stagedReleasePayload = '';

  constructor(role, pair, behavior = 'success') {
    this.role = role;
    this.pair = pair;
    this.behavior = behavior;
    queueMicrotask(() => {
      this.emit('open');
      if (this.behavior === 'silent') return;
      if (this.behavior === 'pre-identity-close') {
        this.emit('close');
        return;
      }
      if (this.behavior === 'pre-identity-error-frame') {
        this.emitFrame({ type: 'error', data: 'subscriber still active' });
        return;
      }
      const providerSessionId =
        this.role === 'main'
          ? this.pair.mainSessionId
          : this.pair.injectorSessionId;
      if (this.behavior === 'new-session-frame') {
        this.emitFrame({ type: 'session_id', data: providerSessionId });
        return;
      }
      this.emitFrame({
        type: 'terminal_restored',
        data:
          this.behavior === 'identity-mismatch'
            ? 'wrong-provider-session'
            : this.behavior === 'restore-schema-mismatch'
              ? { message: 'restored' }
            : `Session ${providerSessionId.slice(0, 8)} restored`,
      });
      if (this.behavior === 'duplicate-restored') {
        this.emitFrame({
          type: 'terminal_restored',
          data: `Session ${providerSessionId.slice(0, 8)} restored`,
        });
      }
    });
  }

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  send(raw, callback) {
    this.sent.push(JSON.parse(raw));
    const data = this.sent.at(-1).data;
    if (this.behavior === 'silent') return;
    if (this.behavior === 'duplicate-restored') return;
    if (this.behavior === 'send-error') {
      callback?.(new Error('sensitive reconnect write error'));
      this.emit('error');
      return;
    }
    if (
      this.behavior === 'stage-send-error' &&
      data !== `${this.pair.closeToken}\n`
    ) {
      callback?.(new Error('sensitive staged write error'));
      this.emit('error');
      return;
    }
    if (this.behavior === 'output-limit') {
      callback?.();
      this.emitFrame({ type: 'output', data: 'x'.repeat(256) });
      return;
    }
    if (this.behavior === 'echo-only') {
      callback?.();
      this.emitFrame({ type: 'restore_output', data });
      return;
    }
    if (
      this.role === 'injector' &&
      data === `${this.pair.closeToken}\n`
    ) {
      if (this.behavior === 'loop-failed') {
        const failureMarker = this.pair.releaseMarker.replace(
          'INJECTOR_RELEASED',
          'INJECTOR_FAILED',
        );
        this.emitFrame({ type: 'output', data: `\r\n${failureMarker}\r\n` });
      } else if (this.behavior !== 'pre-loop') {
        this.emitFrame({
          type: 'output',
          data: this.pair.releaseMarker.slice(0, 9),
        });
        this.emitFrame({
          type: 'output',
          data: this.pair.releaseMarker.slice(9),
        });
      }
      callback?.();
      return;
    }
    const chunk =
      /cap_stage_data="\$\{cap_stage_data\}"'([A-Za-z0-9+/=]+)'/u.exec(
        data,
      )?.[1];
    if (chunk) this.stagedReleasePayload += chunk;
    if (data.includes('eval "$cap_stage_script"')) {
      const releaseCommand = Buffer.from(
        this.stagedReleasePayload,
        'base64',
      ).toString('utf8');
      const mainOutcomeMarker = extractEchoSafeMainOutcomeMarker(
        releaseCommand,
      );
      const emittedMainOutcomeMarker =
        this.behavior === 'main-absent' && mainOutcomeMarker
          ? mainOutcomeMarker.replace('MAIN_READY', 'MAIN_ABSENT')
          : mainOutcomeMarker;
      const marker = extractEchoSafeExitMarker(
        releaseCommand,
        this.role.toUpperCase(),
      );
      if (this.behavior === 'execute-send-error') {
        if (emittedMainOutcomeMarker) {
          this.emitFrame({
            type: 'output',
            data: `\r\n${emittedMainOutcomeMarker}\r\n`,
          });
        }
        if (marker) {
          this.emitFrame({ type: 'output', data: `\r\n${marker}\r\n` });
        }
        callback?.(new Error('sensitive execute write error'));
        this.emit('error');
        return;
      }
      callback?.();
      if (this.behavior === 'exit-before-state') {
        if (marker) {
          this.emitFrame({ type: 'output', data: `\r\n${marker}\r\n` });
        }
        if (emittedMainOutcomeMarker) {
          this.emitFrame({
            type: 'output',
            data: `\r\n${emittedMainOutcomeMarker}\r\n`,
          });
        }
        return;
      }
      if (this.behavior === 'state-restore-only') {
        if (emittedMainOutcomeMarker) {
          this.emitFrame({
            type: 'restore_output',
            data: `\r\n${emittedMainOutcomeMarker}\r\n`,
          });
        }
        if (marker) {
          this.emitFrame({ type: 'output', data: `\r\n${marker}\r\n` });
        }
        return;
      }
      if (emittedMainOutcomeMarker) {
        this.emitFrame({
          type: 'output',
          data: `\r\n${emittedMainOutcomeMarker}\r\n`,
        });
        if (this.behavior === 'duplicate-state') {
          this.emitFrame({
            type: 'output',
            data: `\r\n${emittedMainOutcomeMarker}\r\n`,
          });
        }
        if (this.behavior === 'duplicate-state-after-window') {
          this.emitFrame({ type: 'output', data: 'x'.repeat(20_000) });
          this.emitFrame({
            type: 'output',
            data: `\r\n${emittedMainOutcomeMarker}\r\n`,
          });
        }
        if (this.behavior === 'both-states') {
          this.emitFrame({
            type: 'output',
            data: `\r\n${emittedMainOutcomeMarker.replace(
              'MAIN_READY',
              'MAIN_ABSENT',
            )}\r\n`,
          });
        }
      }
      if (marker) {
        this.emitFrame({ type: 'output', data: `\r\n${marker}\r\n` });
      }
      return;
    }
    const progressMarkers = extractEchoSafeMarkers(data);
    if (progressMarkers.length > 0) {
      if (this.behavior === 'stage-no-ack') {
        callback?.();
        return;
      }
      for (const marker of progressMarkers) {
        const frameType =
          this.behavior === 'stage-restore-ack'
            ? 'restore_output'
            : 'output';
        this.emitFrame({ type: frameType, data: `\r\n${marker}\r\n` });
        if (this.behavior === 'stage-duplicate-ack') {
          this.emitFrame({ type: frameType, data: `\r\n${marker}\r\n` });
        }
        if (this.behavior === 'stage-duplicate-ack-after-window') {
          this.emitFrame({ type: 'output', data: 'x'.repeat(20_000) });
          this.emitFrame({ type: frameType, data: `\r\n${marker}\r\n` });
        }
      }
      callback?.();
      return;
    }
    const releaseCommand = this.stagedReleasePayload
      ? Buffer.from(this.stagedReleasePayload, 'base64').toString('utf8')
      : data;
    const marker = extractEchoSafeExitMarker(
      releaseCommand,
      this.role.toUpperCase(),
    );
    callback?.();
    if (marker) this.emitFrame({ type: 'output', data: `\r\n${marker}\r\n` });
  }

  close() {
    this.terminated = true;
    this.readyState = 3;
  }

  terminate() {
    this.close();
  }

  emitFrame(frame) {
    this.emit('message', Buffer.from(JSON.stringify(frame)));
  }

  emit(event, value) {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

function extractEchoSafeExitMarker(data, role) {
  const match = new RegExp(
    `printf '\\\\r\\\\n(CAP_AIO_${role}_EXIT_)%s\\\\r\\\\n' '([A-Za-z0-9]{8,64})'`,
    'u',
  ).exec(data);
  return match ? `${match[1]}${match[2]}` : null;
}

function extractEchoSafeMainOutcomeMarker(data) {
  const match =
    /printf '\\r\\n(CAP_AIO_MAIN_(?:READY|ABSENT)_)%s\\r\\n' '([A-Za-z0-9]{8,64})'/u.exec(
      data,
    );
  return match ? `${match[1]}${match[2]}` : null;
}

function extractEchoSafeMarkers(data) {
  return [
    ...data.matchAll(
      /printf '\\r\\n(CAP_AIO_[A-Z_]+_)%s\\r\\n' '([A-Za-z0-9]{8,64})'/gu,
    ),
  ].map((match) => `${match[1]}${match[2]}`);
}

function assertBoundedCanonicalPtyLines(input) {
  const byteLengths = input
    .split('\n')
    .map((line) => Buffer.byteLength(line, 'utf8'));
  const maxLineBytes = Math.max(...byteLengths);
  assert.ok(maxLineBytes <= 1_024, `maxLineBytes=${maxLineBytes}`);
  return { byteLengths, maxLineBytes };
}

/**
 * Shared manual `Date.now` stub extracted from the two verified inline
 * precedents in this file (the queued-production-budget and budget-recovery
 * tests). Every time-budget margin asserted in this file must read this
 * injected clock — never the real one — so CPU contention on a loaded host
 * cannot move an elapsed-window measurement. Callbacks advance simulated time
 * explicitly via `clock.advance(ms)`; the original `Date.now` is always
 * restored in `finally`.
 */
async function withManualReleaseClock(startedAt, run) {
  const originalDateNow = Date.now;
  let now = startedAt;
  const clock = {
    advance(ms) {
      now += ms;
    },
    elapsed() {
      return now - startedAt;
    },
  };
  Date.now = () => now;
  try {
    return await run(clock);
  } finally {
    Date.now = originalDateNow;
  }
}

function createExactReleaseHarness({
  pair = ownershipPair(),
  socketBehavior = 'success',
  injectorSocketBehavior = socketBehavior,
  mainSocketBehavior = socketBehavior,
  verificationExitCode = 0,
  mainFingerprintState = 'exact-present',
  injectorFingerprintState = 'exact-present',
  mainTtyState = 'detached',
  verificationDelayMs = 0,
  responseCommandTransform = (command) => command,
  proofOutputTransform = (output) => output,
} = {}) {
  const sockets = [];
  const fetchCalls = [];
  let proofExecutions = 0;
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(init.body) : undefined;
    fetchCalls.push({ path: url.pathname, method: init.method, body });
    if (url.pathname === '/v1/shell/sessions/create') {
      return response(200, {
        success: true,
        data: { session_id: body.id, working_dir: '/home/gem' },
      });
    }
    if (url.pathname === '/v1/shell/exec') {
      if (verificationDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, verificationDelayMs));
      }
      if (body.command.includes('cap_verify_pair()')) {
        proofExecutions += 1;
        const proofShell = unwrapSingleQuotedShLc(body.command);
        const nonces = [
          ...proofShell.matchAll(
            /cap_verify_pair '([A-Za-z0-9]{8,64})' '[01]'/gu,
          ),
        ].map((match) => match[1]);
        const physicalState =
          mainFingerprintState === 'identity-mismatch' ||
          injectorFingerprintState === 'identity-mismatch' ||
          mainTtyState === 'identity-mismatch'
            ? 'IDENTITY_MISMATCH'
            : mainTtyState === 'attached'
              ? 'UNCONFIRMED'
            : (injectorSocketBehavior === 'success' ||
                  injectorSocketBehavior === 'pre-loop' ||
                  (proofExecutions > 1 && mainSocketBehavior === 'success'))
              ? 'CONFIRMED'
              : mainFingerprintState === 'confirmed-absent' &&
                  injectorFingerprintState === 'confirmed-absent'
                ? 'CONFIRMED'
                : injectorFingerprintState === 'confirmed-absent' &&
                    mainFingerprintState === 'exact-present'
                  ? 'MAIN_RECOVERABLE'
                  : 'UNCONFIRMED';
        const proofOutput =
          nonces
            .map((nonce) => `CAP_AIO_PAIR_${physicalState}_${nonce}`)
            .join('\n') + (nonces.length > 0 ? '\n' : '');
        return response(200, {
          success: true,
          data: {
            session_id: body.id,
            command: responseCommandTransform(body.command),
            status: 'completed',
            exit_code: verificationExitCode,
            output: proofOutputTransform(proofOutput),
          },
        });
      }
      if (body.command.includes('__cap_exact_guest_present__')) {
        const fingerprintState = body.command.includes(
          `/proc/${pair.main.pid}/stat`,
        )
          ? mainFingerprintState
          : injectorFingerprintState;
        const output =
          fingerprintState === 'exact-present'
            ? '__cap_exact_guest_present__\n'
            : fingerprintState === 'confirmed-absent'
              ? '__cap_exact_guest_absent__\n'
              : '';
        return response(200, {
          success: true,
          data: {
            session_id: body.id,
            command: responseCommandTransform(body.command),
            status: 'completed',
            exit_code: fingerprintState === 'identity-mismatch' ? 78 : 0,
            output,
          },
        });
      }
      const marker = /__(?:cap_exact_owner_tty_absent|cap_exact_guest_absent)__/u.exec(
        body.command,
      )?.[0];
      return response(200, {
        success: true,
        data: {
          session_id: body.id,
          command: responseCommandTransform(body.command),
          status: 'completed',
          exit_code: verificationExitCode,
          output: marker ? `${marker}\n` : '',
        },
      });
    }
    if (
      init.method === 'DELETE' &&
      url.pathname.startsWith('/v1/shell/sessions/')
    ) {
      const sessionId = decodeURIComponent(
        url.pathname.slice('/v1/shell/sessions/'.length),
      );
      return response(200, {
        success: true,
        data: { session_id: sessionId },
      });
    }
    throw new Error('unexpected exact-release request');
  };
  const socketFactory = (url, role) => {
    assert.equal(
      new URL(url).searchParams.get('session_id'),
      role === 'main' ? pair.mainSessionId : pair.injectorSessionId,
    );
    const selectedBehavior =
      role === 'main' ? mainSocketBehavior : injectorSocketBehavior;
    const behavior =
      role === 'injector' &&
      selectedBehavior === 'success' &&
      mainFingerprintState === 'confirmed-absent'
        ? 'main-absent'
        : selectedBehavior;
    const socket = new FakeReconnectSocket(role, pair, behavior);
    sockets.push(socket);
    return socket;
  };
  return { pair, fetch, fetchCalls, socketFactory, sockets };
}

function createJournalFetch({
  records,
  deleteModes = new Map(),
  mainTtyState = 'detached',
}) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.pathname, method: init.method ?? 'GET', body });

    if (url.pathname === '/v1/file/list' && init.method === 'POST') {
      const files = [...records].map(([path, content]) => ({
        name: path.slice(path.lastIndexOf('/') + 1),
        path,
        is_directory: false,
        size: Buffer.byteLength(content, 'utf8'),
      }));
      return response(200, {
        success: true,
        data: {
          path: body.path,
          files,
          total_count: files.length,
          directory_count: 0,
          file_count: files.length,
        },
      });
    }
    if (url.pathname === '/v1/file/read' && init.method === 'POST') {
      const content = records.get(body.file);
      if (content === undefined) {
        return response(404, { success: false, data: null, message: 'not found' });
      }
      return response(200, {
        success: true,
        data: { file: body.file, content },
      });
    }
    if (url.pathname === '/v1/shell/sessions/create' && init.method === 'POST') {
      return response(200, {
        success: true,
        data: { session_id: body.id, working_dir: '/home/gem' },
      });
    }
    if (url.pathname === '/v1/shell/exec' && init.method === 'POST') {
      if (body.command.includes('cap_verify_pair()')) {
        const proofShell = unwrapSingleQuotedShLc(body.command);
        const nonces = [
          ...proofShell.matchAll(
            /cap_verify_pair '([A-Za-z0-9]{8,64})' '[01]'/gu,
          ),
        ].map((match) => match[1]);
        return response(200, {
          success: true,
          data: {
            session_id: body.id,
            command: body.command,
            status: 'completed',
            exit_code: 0,
            output:
              nonces
                .map(
                  (nonce) =>
                    `CAP_AIO_PAIR_${
                      mainTtyState === 'attached'
                        ? 'UNCONFIRMED'
                        : 'CONFIRMED'
                    }_${nonce}`,
                )
                .join('\n') + (nonces.length > 0 ? '\n' : ''),
          },
        });
      }
      if (body.command.includes('__cap_exact_guest_present__')) {
        return response(200, {
          success: true,
          data: {
            session_id: body.id,
            command: body.command,
            status: 'completed',
            exit_code: 0,
            output: '__cap_exact_guest_present__\n',
          },
        });
      }
      const verificationMarker =
        /__(?:cap_exact_owner_tty_absent|cap_exact_guest_absent)__/u.exec(
          body.command,
        )?.[0];
      return response(200, {
        success: true,
        data: {
          session_id: body.id,
          command: body.command,
          status: 'completed',
          exit_code: 0,
          output: verificationMarker ? `${verificationMarker}\n` : '',
        },
      });
    }
    if (
      init.method === 'DELETE' &&
      url.pathname.startsWith('/v1/shell/sessions/')
    ) {
      const sessionId = decodeURIComponent(
        url.pathname.slice('/v1/shell/sessions/'.length),
      );
      const mode = deleteModes.get(sessionId) ?? 'deleted';
      if (mode === 'fail') {
        return response(503, { success: false, data: null });
      }
      if (mode === 'absent') {
        return response(200, {
          success: false,
          message: `Session ${sessionId} not found`,
          data: { session_id: sessionId },
        });
      }
      return response(200, {
        success: true,
        data: { session_id: sessionId },
      });
    }
    return response(404, { success: false, data: null });
  };
  return { fetch, calls };
}

function listResult(path, files, counts = {}) {
  return {
    success: true,
    data: {
      path,
      files,
      total_count: files.length,
      directory_count: 0,
      file_count: files.length,
      ...counts,
    },
  };
}

function journalEntry(path, content, overrides = {}) {
  return {
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    is_directory: false,
    size: Buffer.byteLength(content, 'utf8'),
    ...overrides,
  };
}

async function sweepWithProtocol({
  ownershipScope = scope(),
  processFingerprint = 'a'.repeat(64),
  listStatus = 200,
  listBody,
  listJsonReject = false,
  listPromise,
  readStatus = 200,
  readBody,
  readReject = false,
  timing,
}) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.pathname, method: init.method, body });
    if (url.pathname === '/v1/file/list') {
      if (listPromise) return listPromise();
      if (listJsonReject) {
        return {
          ok: true,
          status: 200,
          async json() {
            throw new Error('invalid json');
          },
        };
      }
      return response(listStatus, listBody);
    }
    if (url.pathname === '/v1/file/read') {
      if (readReject) throw new Error('read unavailable');
      return response(readStatus, readBody);
    }
    throw new Error('unexpected destructive request');
  };
  const settlement = await mod.sweepAioStaleTerminalSessions({
    fetch,
    baseUrl: 'http://aio.test',
    scope: ownershipScope,
    processFingerprint,
    timing,
    guestPairReleaser: confirmedGuestPairReleaser,
  });
  return { settlement, calls };
}

await test('encrypted journal material hides native and durable identities', async () => {
  const processFingerprint = 'a'.repeat(64);
  const providerSessionId = canonicalProviderSessionId(101);
  const ownershipScope = scope();
  const record = ownershipRecord({
    providerSessionId,
    ownershipScope,
    processFingerprint,
  });
  const serialized = `${record.path}\n${record.content}`;
  for (const secret of [
    providerSessionId,
    ownershipScope.taskId,
    ownershipScope.providerSandboxId,
    ownershipScope.ownership.ownerGeneration,
    ownershipScope.ownership.resourceGeneration,
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.match(
    record.path,
    /^\/tmp\/\.cap-aio-terminal-pairs-v2\/[0-9a-f]{64}\.owner$/u,
  );
  const shell = mod.buildAioTerminalOwnershipRegistrationShell({
    record,
    nonce: 'main00000001',
  });
  assert.equal(spawnSync('bash', ['-n', '-c', shell]).status, 0);
  assert.match(shell, /umask 077.*mkdir -p.*chmod 600/u);
  assert.equal(shell.includes(providerSessionId), false);
  assert.equal(shell.includes(ownershipScope.ownership.resourceGeneration), false);
});

await test('ownership constructors validate every externally supplied identity boundary', async () => {
  const currentFingerprint = mod.currentAioTerminalProcessFingerprint();
  assert.match(currentFingerprint, /^[0-9a-f]{64}$/u);
  const validScope = scope();
  assert.equal(mod.isCompleteAioTerminalOwnershipScope(validScope), true);
  assert.equal(
    mod.isCompleteAioTerminalOwnershipScope(validScope, validScope.taskId),
    true,
  );
  assert.equal(
    mod.isCompleteAioTerminalOwnershipScope(validScope, 'different-task'),
    false,
  );
  for (const invalidScope of [
    undefined,
    { ...validScope, ownership: undefined },
    { ...validScope, ownership: 'invalid' },
    { ...validScope, taskId: '' },
    { ...validScope, providerSandboxId: '' },
    {
      ...validScope,
      ownership: { ...validScope.ownership, ownerGeneration: '' },
    },
    {
      ...validScope,
      ownership: { ...validScope.ownership, resourceGeneration: '' },
    },
    { ...validScope, taskId: 'x'.repeat(513) },
  ]) {
    assert.equal(mod.isCompleteAioTerminalOwnershipScope(invalidScope), false);
  }

  const defaults = mod.createAioTerminalOwnershipRecord({
    pair: ownershipPair(),
    scope: validScope,
  });
  assert.match(defaults.content, new RegExp(`:${currentFingerprint}:`, 'u'));
  for (const providerSessionId of [
    '',
    7,
    'line\nbreak',
    `delete${String.fromCharCode(0x7f)}`,
    'x'.repeat(513),
  ]) {
    assert.throws(() =>
      mod.createAioTerminalOwnershipRecord({
        pair: ownershipPair({ mainSessionId: providerSessionId }),
        scope: validScope,
        processFingerprint: 'a'.repeat(64),
      }),
    );
  }
  assert.throws(() =>
    mod.createAioTerminalOwnershipRecord({
      pair: ownershipPair(),
      scope: { ...validScope, taskId: '' },
      processFingerprint: 'a'.repeat(64),
    }),
  );
  assert.throws(() =>
    mod.createAioTerminalOwnershipRecord({
      pair: ownershipPair({
        mainSessionId: 'abcdef01-0000-4000-8000-000000000001',
        injectorSessionId: 'abcdef01-1111-4111-8111-000000000002',
      }),
      scope: validScope,
      processFingerprint: 'a'.repeat(64),
    }),
  );
  assert.throws(() =>
    mod.createAioTerminalOwnershipRecord({
      pair: ownershipPair(),
      scope: validScope,
      processFingerprint: 'not-a-fingerprint',
    }),
  );
  assert.throws(() =>
    mod.createAioTerminalOwnershipRecord({
      pair: ownershipPair({
        mainSessionId: 'same',
        injectorSessionId: 'same',
      }),
      scope: validScope,
      processFingerprint: 'a'.repeat(64),
    }),
  );
  assert.throws(() =>
    mod.createAioTerminalOwnershipRecord({
      pair: ownershipPair(),
      scope: validScope,
      processFingerprint: 'a'.repeat(64),
      iv: Uint8Array.of(1),
    }),
  );
  assert.throws(() =>
    mod.buildAioTerminalOwnershipRegistrationShell({
      record: { ...defaults, path: '/tmp/not-owned' },
      nonce: 'main00000001',
    }),
  );
  assert.throws(() =>
    mod.buildAioTerminalOwnershipRegistrationShell({
      record: defaults,
      nonce: 'bad',
    }),
  );
  assert.throws(() =>
    mod.buildAioTerminalOwnershipRegistrationShell({
      record: { ...defaults, content: 'invalid' },
      nonce: 'main00000001',
    }),
  );
  let sweepCalled = false;
  const invalidSweep = await mod.sweepAioStaleTerminalSessions({
    fetch: async () => {
      sweepCalled = true;
      throw new Error('must not run');
    },
    baseUrl: 'http://aio.test',
    scope: validScope,
    processFingerprint: 'invalid',
  });
  assert.equal(invalidSweep.kind, 'indeterminate');
  assert.equal(invalidSweep.cause, 'ownership-unavailable');
  assert.equal(sweepCalled, false);
  const defaultProcessSweep = await mod.sweepAioStaleTerminalSessions({
    fetch: async () =>
      response(200, {
        success: false,
        data: null,
        message: 'journal directory does not exist',
      }),
    baseUrl: 'http://aio.test',
    scope: validScope,
  });
  assert.equal(defaultProcessSweep.kind, 'confirmed');
});

await test('exact reconnect release closes the nonce-bound injector and main pair before REST proof', async () => {
  const harness = createExactReleaseHarness();
  const nonces = ['injector00000001', 'main00000001'];
  const settlement = await mod.releaseAioTerminalGuestPairExact({
    fetch: harness.fetch,
    baseUrl: 'http://aio.test',
    taskId: 'release-task',
    pair: harness.pair,
    timeoutMs: 500,
    maxOutputBytes: 4_096,
    socketFactory: harness.socketFactory,
    markerFactory: () => nonces.shift(),
  });
  assert.deepEqual(
    settlement,
    { kind: 'confirmed', cause: null },
    JSON.stringify({
      sent: harness.sockets.map((socket) => socket.sent.length),
      staged: harness.sockets.map((socket) => socket.stagedReleasePayload.length),
    }),
  );
  assert.deepEqual(
    harness.sockets.map((socket) => socket.role),
    ['injector', 'main'],
  );
  assert.ok(harness.sockets.every((socket) => socket.terminated));
  assert.ok(harness.sockets.every((socket) => socket.sent.length > 0));
  for (const socket of harness.sockets) {
    for (const frame of socket.sent) {
      assert.equal(
        spawnSync('bash', ['--noprofile', '--norc', '-n', '-c', frame.data])
          .status,
        0,
      );
      assertBoundedCanonicalPtyLines(frame.data);
      assert.ok(Buffer.byteLength(frame.data, 'utf8') <= 1_024);
      assert.equal(frame.data.endsWith('\n'), true);
      assert.equal(frame.data.slice(0, -1).includes('\n'), false);
    }
  }
  assert.ok(harness.sockets[0].sent.length > 3);
  assert.equal(
    harness.sockets[0].sent[0].data,
    `${harness.pair.closeToken}\n`,
  );
  const stagedReleaseCommand = Buffer.from(
    harness.sockets[0].stagedReleasePayload,
    'base64',
  ).toString('utf8');
  assert.equal(
    spawnSync('bash', ['--noprofile', '--norc', '-n', '-c', stagedReleaseCommand])
      .status,
    0,
  );
  assert.equal(
    extractEchoSafeExitMarker(stagedReleaseCommand, 'INJECTOR'),
    'CAP_AIO_INJECTOR_EXIT_injector00000001',
  );
  assert.doesNotMatch(
    harness.sockets[0].sent.map((frame) => frame.data).join(''),
    /CAP_AIO_INJECTOR_EXIT_injector00000001/u,
  );
  const injectorOutcomeMarker = extractEchoSafeMainOutcomeMarker(
    stagedReleaseCommand,
  );
  assert.equal(
    injectorOutcomeMarker,
    'CAP_AIO_MAIN_READY_injector00000001',
  );
  assert.equal(
    harness.sockets[0].sent
      .map((frame) => frame.data)
      .join('')
      .includes(injectorOutcomeMarker),
    false,
  );
  assert.match(stagedReleaseCommand, /\/dev\/pts\/11/u);
  assert.match(stagedReleaseCommand, /\/dev\/pts\/12/u);
  assert.match(stagedReleaseCommand, /-t '=taskrelease-task'/u);
  assert.match(
    stagedReleaseCommand,
    /readlink "\/proc\/\$\$\/fd\/9"/u,
  );
  assert.doesNotMatch(
    stagedReleaseCommand,
    /readlink '\/proc\/\$\$\/fd\/9'/u,
  );
  assert.equal(
    extractEchoSafeExitMarker(harness.sockets[1].sent[0].data, 'MAIN'),
    'CAP_AIO_MAIN_EXIT_main00000001',
  );
  assert.doesNotMatch(
    harness.sockets[1].sent[0].data,
    /CAP_AIO_MAIN_EXIT_main00000001/u,
  );
  const verificationCalls = harness.fetchCalls.filter(
    (call) => call.path === '/v1/shell/exec',
  );
  assert.equal(verificationCalls.length, 1);
  for (const call of verificationCalls) {
    assert.match(call.body.command, /^sh -lc '/u);
    assert.equal(
      spawnSync('bash', ['--noprofile', '--norc', '-n', '-c', call.body.command])
        .status,
      0,
    );
    assert.equal(
      spawnSync('bash', [
        '--noprofile',
        '--norc',
        '-n',
        '-c',
        unwrapSingleQuotedShLc(call.body.command),
      ]).status,
      0,
    );
  }
  const proofShell = unwrapSingleQuotedShLc(
    verificationCalls[0].body.command,
  );
  assert.match(proofShell, /cap_verify_pair\(\)/u);
  assert.equal(
    proofShell
      .replace(/\r\n|\r/gu, '\n')
      .split('\n')
      .some((line) => line.startsWith('CAP_AIO_PAIR_')),
    false,
    'submitted proof source must not echo a standalone reserved marker line',
  );
  for (const fingerprint of [harness.pair.main, harness.pair.injector]) {
    assert.match(proofShell, new RegExp(fingerprint.pid, 'u'));
    assert.match(proofShell, new RegExp(fingerprint.startTime, 'u'));
    assert.match(proofShell, new RegExp(fingerprint.bootId, 'u'));
    assert.match(proofShell, new RegExp(fingerprint.tty, 'u'));
  }
  assert.equal(
    JSON.stringify(settlement).includes(harness.pair.mainSessionId),
    false,
  );
});

await test('same-task owner plus eight viewers share one exact REST proof cohort', async () => {
  const calls = [];
  const events = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.pathname, method: init.method, body });
    if (url.pathname === '/v1/shell/sessions/create') {
      return response(200, {
        success: true,
        data: { session_id: body.id, working_dir: '/home/gem' },
      });
    }
    if (url.pathname === '/v1/shell/exec') {
      events.push('proof');
      const proofShell = unwrapSingleQuotedShLc(body.command);
      const nonces = [
        ...proofShell.matchAll(
          /cap_verify_pair '([A-Za-z0-9]{8,64})' '[01]'/gu,
        ),
      ].map((match) => match[1]);
      return response(200, {
        success: true,
        data: {
          session_id: body.id,
          command: body.command,
          status: 'completed',
          exit_code: 0,
          output:
            nonces
              .map((nonce) => `CAP_AIO_PAIR_CONFIRMED_${nonce}`)
              .join('\n') + '\n',
        },
      });
    }
    if (
      init.method === 'DELETE' &&
      url.pathname.startsWith('/v1/shell/sessions/')
    ) {
      const sessionId = decodeURIComponent(
        url.pathname.slice('/v1/shell/sessions/'.length),
      );
      return response(200, {
        success: true,
        data: { session_id: sessionId },
      });
    }
    throw new Error('unexpected cohort request');
  };
  const pairs = Array.from({ length: 9 }, (_, index) =>
    ownershipPair({
      mainSessionId: canonicalProviderSessionId(300 + index * 2),
      injectorSessionId: canonicalProviderSessionId(301 + index * 2),
      slot: 300 + index * 2,
      closeNonce: `cohort${String(index).padStart(8, '0')}`,
    }),
  );
  const sockets = pairs.map(() => []);
  const decisions = pairs.map((pair, index) => {
    const nonces = [
      `injector${String(index).padStart(8, '0')}`,
      `main${String(index).padStart(12, '0')}`,
    ];
    return mod.releaseAioTerminalGuestPairExact({
      fetch,
      baseUrl: 'http://aio.test/',
      taskId: 'release-cohort',
      pair,
      timeoutMs: 8_000,
      maxOutputBytes: 4_096,
      socketFactory: (url, role) => {
        assert.equal(
          new URL(url).searchParams.get('session_id'),
          role === 'main' ? pair.mainSessionId : pair.injectorSessionId,
        );
        events.push(role);
        const socket = new FakeReconnectSocket(role, pair, 'success');
        sockets[index].push(socket);
        return socket;
      },
      markerFactory: () => nonces.shift(),
    });
  });
  const settlements = await Promise.all(decisions);
  assert.ok(
    settlements.every(
      (settlement) =>
        settlement.kind === 'confirmed' && settlement.cause === null,
    ),
  );
  assert.equal(
    calls.filter(({ path }) => path === '/v1/shell/sessions/create').length,
    1,
  );
  const proofCalls = calls.filter(({ path }) => path === '/v1/shell/exec');
  assert.equal(proofCalls.length, 1);
  assert.equal(
    [
      ...unwrapSingleQuotedShLc(proofCalls[0].body.command).matchAll(
        /cap_verify_pair '([A-Za-z0-9]{8,64})' '[01]'/gu,
      ),
    ].length,
    9,
  );
  assert.equal(
    calls.filter(
      ({ path, method }) =>
        method === 'DELETE' && path.startsWith('/v1/shell/sessions/'),
    ).length,
    1,
  );
  assert.equal(events.indexOf('proof'), 18);
  assert.deepEqual(events.slice(0, 9), Array(9).fill('injector'));
  assert.deepEqual(events.slice(9, 18), Array(9).fill('main'));
  assert.ok(sockets.flat().every((socket) => socket.terminated));
});

await test('a silent cohort peer cannot block a successful peer from main exit and one final proof', async () => {
  const calls = [];
  const events = [];
  let clock;
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.pathname, method: init.method, body });
    // Each REST call costs simulated budget on the injected clock; the margin
    // assertion below therefore measures protocol work, not host scheduling.
    clock.advance(10);
    if (url.pathname === '/v1/shell/sessions/create') {
      return response(200, {
        success: true,
        data: { session_id: body.id, working_dir: '/home/gem' },
      });
    }
    if (url.pathname === '/v1/shell/exec') {
      events.push('proof');
      const nonces = [
        ...unwrapSingleQuotedShLc(body.command).matchAll(
          /cap_verify_pair '([A-Za-z0-9]{8,64})' '[01]'/gu,
        ),
      ].map((match) => match[1]);
      assert.equal(nonces.length, 2);
      return response(200, {
        success: true,
        data: {
          session_id: body.id,
          command: body.command,
          status: 'completed',
          exit_code: 0,
          output:
            `CAP_AIO_PAIR_CONFIRMED_${nonces[0]}\n` +
            `CAP_AIO_PAIR_UNCONFIRMED_${nonces[1]}\n`,
        },
      });
    }
    if (
      init.method === 'DELETE' &&
      url.pathname.startsWith('/v1/shell/sessions/')
    ) {
      const sessionId = decodeURIComponent(
        url.pathname.slice('/v1/shell/sessions/'.length),
      );
      return response(200, {
        success: true,
        data: { session_id: sessionId },
      });
    }
    throw new Error('unexpected isolated-cohort request');
  };
  const fastPair = ownershipPair({
    mainSessionId: canonicalProviderSessionId(380),
    injectorSessionId: canonicalProviderSessionId(381),
    slot: 380,
    closeNonce: 'isolatefast0001',
  });
  const silentPair = ownershipPair({
    mainSessionId: canonicalProviderSessionId(382),
    injectorSessionId: canonicalProviderSessionId(383),
    slot: 382,
    closeNonce: 'isolateslow0001',
  });
  const fastSockets = [];
  const silentSockets = [];
  const fastNonces = ['fastinjector001', 'fastmain0000001'];
  const silentNonces = ['slowinjector001'];
  const timeoutMs = 120;
  const keepAlive = setTimeout(() => undefined, timeoutMs + 50);
  let fast;
  let silent;
  await withManualReleaseClock(30_000_000, async (manualClock) => {
    clock = manualClock;
    [fast, silent] = await Promise.all([
      mod.releaseAioTerminalGuestPairExact({
        fetch,
        baseUrl: 'http://aio.test',
        taskId: 'isolate-cohort',
        pair: fastPair,
        timeoutMs,
        socketFactory: (_url, role) => {
          events.push(`fast-${role}`);
          clock.advance(10);
          const socket = new FakeReconnectSocket(role, fastPair, 'success');
          fastSockets.push(socket);
          return socket;
        },
        markerFactory: () => fastNonces.shift(),
      }),
      mod.releaseAioTerminalGuestPairExact({
        fetch,
        baseUrl: 'http://aio.test/',
        taskId: 'isolate-cohort',
        pair: silentPair,
        timeoutMs,
        socketFactory: (_url, role) => {
          events.push(`slow-${role}`);
          clock.advance(10);
          const socket = new FakeReconnectSocket(role, silentPair, 'silent');
          silentSockets.push(socket);
          return socket;
        },
        markerFactory: () => silentNonces.shift(),
      }),
    ]);
  });
  clearTimeout(keepAlive);
  assert.deepEqual(fast, { kind: 'confirmed', cause: null });
  assert.deepEqual(silent, { kind: 'indeterminate', cause: 'timeout' });
  assert.ok(clock.elapsed() < timeoutMs, `elapsed=${clock.elapsed()}`);
  assert.deepEqual(
    fastSockets.map((socket) => socket.role),
    ['injector', 'main'],
  );
  assert.deepEqual(
    silentSockets.map((socket) => socket.role),
    ['injector'],
  );
  assert.ok(events.indexOf('fast-main') < events.indexOf('proof'));
  assert.equal(
    calls.filter(({ path }) => path === '/v1/shell/exec').length,
    1,
  );
  assert.equal(
    calls.filter(
      ({ path, method }) =>
        method === 'DELETE' && path.startsWith('/v1/shell/sessions/'),
    ).length,
    1,
  );
  assert.equal(silentSockets[0].terminated, true);
  const sentAtDeadline = silentSockets[0].sent.length;
  silentSockets[0].emitFrame({
    type: 'terminal_restored',
    data: `Session ${silentPair.injectorSessionId.slice(0, 8)} restored`,
  });
  await Promise.resolve();
  assert.equal(silentSockets[0].sent.length, sentAtDeadline);
});

await test('different timeout groups for one task serialize on one lane and retain enqueue deadlines', async () => {
  const events = [];
  const proofPairCounts = [];
  let clock;
  let activeControlSessions = 0;
  let maxActiveControlSessions = 0;
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (url.pathname === '/v1/shell/sessions/create') {
      activeControlSessions += 1;
      maxActiveControlSessions = Math.max(
        maxActiveControlSessions,
        activeControlSessions,
      );
      events.push('create');
      return response(200, {
        success: true,
        data: { session_id: body.id, working_dir: '/home/gem' },
      });
    }
    if (url.pathname === '/v1/shell/exec') {
      events.push('exec');
      const nonces = [
        ...unwrapSingleQuotedShLc(body.command).matchAll(
          /cap_verify_pair '([A-Za-z0-9]{8,64})' '[01]'/gu,
        ),
      ].map((match) => match[1]);
      proofPairCounts.push(nonces.length);
      // Simulated 15ms proof service time on the injected clock: the queued
      // 20ms-deadline release must expire by deadline arithmetic, not by
      // racing real timers on a loaded host.
      clock.advance(15);
      return response(200, {
        success: true,
        data: {
          session_id: body.id,
          command: body.command,
          status: 'completed',
          exit_code: 0,
          output:
            nonces
              .map((nonce) => `CAP_AIO_PAIR_CONFIRMED_${nonce}`)
              .join('\n') + '\n',
        },
      });
    }
    if (
      init.method === 'DELETE' &&
      url.pathname.startsWith('/v1/shell/sessions/')
    ) {
      clock.advance(10);
      activeControlSessions -= 1;
      events.push('delete');
      const sessionId = decodeURIComponent(
        url.pathname.slice('/v1/shell/sessions/'.length),
      );
      return response(200, {
        success: true,
        data: { session_id: sessionId },
      });
    }
    throw new Error('unexpected timeout-lane request');
  };
  const timeouts = [100, 180, 100, 20];
  const pairs = timeouts.map((_, index) =>
    ownershipPair({
      mainSessionId: canonicalProviderSessionId(390 + index * 2),
      injectorSessionId: canonicalProviderSessionId(391 + index * 2),
      slot: 390 + index * 2,
      closeNonce: `timeoutlane${String(index).padStart(4, '0')}`,
    }),
  );
  let settlements;
  await withManualReleaseClock(40_000_000, async (manualClock) => {
    clock = manualClock;
    const decisions = pairs.map((pair, index) => {
      const nonces = [
        `laneinjector${String(index).padStart(4, '0')}`,
        `lanemain${String(index).padStart(8, '0')}`,
      ];
      return mod.releaseAioTerminalGuestPairExact({
        fetch,
        baseUrl: index === 1 ? 'http://aio.test/' : 'http://aio.test',
        taskId: 'timeout-lane',
        pair,
        timeoutMs: timeouts[index],
        socketFactory: (_url, role) =>
          new FakeReconnectSocket(role, pair, 'success'),
        markerFactory: () => nonces.shift(),
      });
    });
    settlements = await Promise.all(decisions);
  });
  assert.ok(
    settlements.slice(0, 3).every(
      (settlement) =>
        settlement.kind === 'confirmed' && settlement.cause === null,
    ),
  );
  assert.deepEqual(settlements[3], {
    kind: 'indeterminate',
    cause: 'timeout',
  });
  assert.deepEqual(proofPairCounts, [2, 1]);
  assert.equal(maxActiveControlSessions, 1);
  assert.deepEqual(events, [
    'create',
    'exec',
    'delete',
    'create',
    'exec',
    'delete',
  ]);
});

await test('a production-timeout cohort queued behind cleanup still retains both reconnects and proof', async () => {
  let clock;
  let activeControlSessions = 0;
  let maxActiveControlSessions = 0;
  let proofOrdinal = 0;
  const events = [];
  const releasedMainSessionIds = new Set();
  const pairs = [
    ownershipPair({
      mainSessionId: canonicalProviderSessionId(410),
      injectorSessionId: canonicalProviderSessionId(411),
      slot: 410,
      closeNonce: 'queuedbudget0001',
    }),
    ownershipPair({
      mainSessionId: canonicalProviderSessionId(412),
      injectorSessionId: canonicalProviderSessionId(413),
      slot: 412,
      closeNonce: 'queuedbudget0002',
    }),
  ];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (url.pathname === '/v1/shell/sessions/create') {
      clock.advance(50);
      activeControlSessions += 1;
      maxActiveControlSessions = Math.max(
        maxActiveControlSessions,
        activeControlSessions,
      );
      events.push('create');
      return response(200, {
        success: true,
        data: { session_id: body.id, working_dir: '/home/gem' },
      });
    }
    if (url.pathname === '/v1/shell/exec') {
      clock.advance(50);
      proofOrdinal += 1;
      events.push(`proof-${proofOrdinal}`);
      const nonces = [
        ...unwrapSingleQuotedShLc(body.command).matchAll(
          /cap_verify_pair '([A-Za-z0-9]{8,64})' '[01]'/gu,
        ),
      ].map((match) => match[1]);
      assert.equal(nonces.length, 1);
      const confirmed = releasedMainSessionIds.size >= proofOrdinal;
      return response(200, {
        success: true,
        data: {
          session_id: body.id,
          command: body.command,
          status: 'completed',
          exit_code: 0,
          output: `CAP_AIO_PAIR_${
            confirmed ? 'CONFIRMED' : 'UNCONFIRMED'
          }_${nonces[0]}\n`,
        },
      });
    }
    if (
      init.method === 'DELETE' &&
      url.pathname.startsWith('/v1/shell/sessions/')
    ) {
      clock.advance(4_500);
      activeControlSessions -= 1;
      events.push('delete');
      const sessionId = decodeURIComponent(
        url.pathname.slice('/v1/shell/sessions/'.length),
      );
      return response(200, {
        success: true,
        data: { session_id: sessionId },
      });
    }
    throw new Error('unexpected queued-budget request');
  };
  let settlements;
  await withManualReleaseClock(20_000_000, async (manualClock) => {
    clock = manualClock;
    const decisions = pairs.map((pair, index) => {
      const nonces = [
        `queuedinjector${index + 1}`,
        `queuedmain00000${index + 1}`,
      ];
      return mod.releaseAioTerminalGuestPairExact({
        fetch,
        baseUrl: 'http://aio.test',
        taskId: 'queued-production-budget',
        pair,
        timeoutMs: index === 0 ? 20_000 : 19_999,
        socketFactory: (_url, role) => {
          if (index === 1) clock.advance(2_000);
          events.push(`pair-${index + 1}-${role}`);
          const socket = new FakeReconnectSocket(role, pair, 'success');
          const send = socket.send.bind(socket);
          socket.send = (raw, callback) => {
            send(raw, callback);
            if (role === 'main') {
              releasedMainSessionIds.add(pair.mainSessionId);
            }
          };
          return socket;
        },
        markerFactory: () => nonces.shift(),
      });
    });
    settlements = await Promise.all(decisions);
  });
  assert.deepEqual(settlements, [
    { kind: 'confirmed', cause: null },
    { kind: 'confirmed', cause: null },
  ]);
  assert.equal(clock.elapsed(), 13_200);
  assert.equal(maxActiveControlSessions, 1);
  assert.equal(activeControlSessions, 0);
  assert.deepEqual(events, [
    'pair-1-injector',
    'pair-1-main',
    'create',
    'proof-1',
    'delete',
    'pair-2-injector',
    'pair-2-main',
    'create',
    'proof-2',
    'delete',
  ]);
});

await test('one batched fingerprint mismatch does not erase confirmed peer proof', async () => {
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (url.pathname === '/v1/shell/sessions/create') {
      return response(200, {
        success: true,
        data: { session_id: body.id, working_dir: '/home/gem' },
      });
    }
    if (url.pathname === '/v1/shell/exec') {
      const nonces = [
        ...unwrapSingleQuotedShLc(body.command).matchAll(
          /cap_verify_pair '([A-Za-z0-9]{8,64})' '[01]'/gu,
        ),
      ].map((match) => match[1]);
      return response(200, {
        success: true,
        data: {
          session_id: body.id,
          command: body.command,
          status: 'completed',
          exit_code: 0,
          output:
            `CAP_AIO_PAIR_IDENTITY_MISMATCH_${nonces[0]}\n` +
            `CAP_AIO_PAIR_CONFIRMED_${nonces[1]}\n`,
        },
      });
    }
    const sessionId = decodeURIComponent(
      url.pathname.slice('/v1/shell/sessions/'.length),
    );
    return response(200, {
      success: true,
      data: { session_id: sessionId },
    });
  };
  const pairs = [410, 420].map((slot) =>
    ownershipPair({
      mainSessionId: canonicalProviderSessionId(slot),
      injectorSessionId: canonicalProviderSessionId(slot + 1),
      slot,
      closeNonce: `isolate${slot}0000`,
    }),
  );
  const decisions = pairs.map((pair, index) => {
    const nonces = [`isoinject${index}000`, `isomain${index}000000`];
    return mod.releaseAioTerminalGuestPairExact({
      fetch,
      baseUrl: 'http://aio.test',
      taskId: 'release-isolation',
      pair,
      timeoutMs: 500,
      socketFactory: (_url, role) =>
        new FakeReconnectSocket(role, pair, 'success'),
      markerFactory: () => nonces.shift(),
    });
  });
  assert.deepEqual(await Promise.all(decisions), [
    { kind: 'indeterminate', cause: 'identity-mismatch' },
    { kind: 'confirmed', cause: null },
  ]);
});

await test('a failed recovery proof cannot erase a peer confirmed by the first batch proof', async () => {
  let proofExecutions = 0;
  let cleanupExecutions = 0;
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (url.pathname === '/v1/shell/sessions/create') {
      return response(200, {
        success: true,
        data: { session_id: body.id, working_dir: '/home/gem' },
      });
    }
    if (url.pathname === '/v1/shell/exec') {
      proofExecutions += 1;
      if (proofExecutions === 2) {
        throw new Error('second proof unavailable');
      }
      const nonces = [
        ...unwrapSingleQuotedShLc(body.command).matchAll(
          /cap_verify_pair '([A-Za-z0-9]{8,64})' '[01]'/gu,
        ),
      ].map((match) => match[1]);
      assert.equal(nonces.length, 2);
      return response(200, {
        success: true,
        data: {
          session_id: body.id,
          command: body.command,
          status: 'completed',
          exit_code: 0,
          output:
            `CAP_AIO_PAIR_CONFIRMED_${nonces[0]}\n` +
            `CAP_AIO_PAIR_MAIN_RECOVERABLE_${nonces[1]}\n`,
        },
      });
    }
    if (
      init.method === 'DELETE' &&
      url.pathname.startsWith('/v1/shell/sessions/')
    ) {
      cleanupExecutions += 1;
      const sessionId = decodeURIComponent(
        url.pathname.slice('/v1/shell/sessions/'.length),
      );
      return response(200, {
        success: true,
        data: { session_id: sessionId },
      });
    }
    throw new Error('unexpected recovery-isolation request');
  };
  const confirmedPair = ownershipPair({
    mainSessionId: canonicalProviderSessionId(430),
    injectorSessionId: canonicalProviderSessionId(431),
    slot: 430,
    closeNonce: 'recoverpeer0001',
  });
  const recoverablePair = ownershipPair({
    mainSessionId: canonicalProviderSessionId(432),
    injectorSessionId: canonicalProviderSessionId(433),
    slot: 432,
    closeNonce: 'recoverfail0001',
  });
  const confirmedNonces = ['peerinjector001', 'peermain0000001'];
  const recoverableNonces = ['failinjector001', 'recovermain0001'];
  const settlements = await Promise.all([
    mod.releaseAioTerminalGuestPairExact({
      fetch,
      baseUrl: 'http://aio.test',
      taskId: 'recovery-isolation',
      pair: confirmedPair,
      timeoutMs: 500,
      socketFactory: (_url, role) =>
        new FakeReconnectSocket(role, confirmedPair, 'success'),
      markerFactory: () => confirmedNonces.shift(),
    }),
    mod.releaseAioTerminalGuestPairExact({
      fetch,
      baseUrl: 'http://aio.test',
      taskId: 'recovery-isolation',
      pair: recoverablePair,
      timeoutMs: 500,
      socketFactory: (_url, role) =>
        new FakeReconnectSocket(
          role,
          recoverablePair,
          role === 'injector' ? 'send-error' : 'success',
        ),
      markerFactory: () => recoverableNonces.shift(),
    }),
  ]);
  assert.deepEqual(settlements[0], { kind: 'confirmed', cause: null });
  assert.deepEqual(settlements[1], {
    kind: 'indeterminate',
    cause: 'protocol-unconfirmed',
  });
  assert.equal(proofExecutions, 2);
  assert.equal(cleanupExecutions, 1);
});

await test('exact reconnect release handles the journal-before-injector-loop crash window', async () => {
  const harness = createExactReleaseHarness({ socketBehavior: 'pre-loop' });
  const nonces = ['injector00000002', 'main00000002'];
  const settlement = await mod.releaseAioTerminalGuestPairExact({
    fetch: harness.fetch,
    baseUrl: 'http://aio.test',
    taskId: 'release-task',
    pair: harness.pair,
    timeoutMs: 500,
    maxOutputBytes: 4_096,
    socketFactory: harness.socketFactory,
    markerFactory: () => nonces.shift(),
  });
  assert.deepEqual(settlement, { kind: 'confirmed', cause: null });
  assert.deepEqual(
    harness.sockets.map((socket) => socket.role),
    ['injector', 'main'],
  );
  assert.ok(harness.sockets[0].sent.length > 3);
  assert.equal(
    harness.sockets[0].sent[0].data,
    `${harness.pair.closeToken}\n`,
  );
  const stagedReleaseCommand = Buffer.from(
    harness.sockets[0].stagedReleasePayload,
    'base64',
  ).toString('utf8');
  assert.equal(
    extractEchoSafeExitMarker(stagedReleaseCommand, 'INJECTOR'),
    'CAP_AIO_INJECTOR_EXIT_injector00000002',
  );
  assert.doesNotMatch(
    harness.sockets[0].sent.map((frame) => frame.data).join(''),
    /CAP_AIO_INJECTOR_EXIT_injector00000002/u,
  );
  assert.equal(
    harness.sockets[0].sent.some((frame) =>
      frame.data.includes(harness.pair.releaseMarker),
    ),
    false,
  );
  assert.ok(harness.sockets.every((socket) => socket.terminated));
  for (const frame of harness.sockets[0].sent) {
    assertBoundedCanonicalPtyLines(frame.data);
  }
});

await test('exact reconnect release writes only after provider identity and ignores command echo', async () => {
  const newSession = createExactReleaseHarness({
    socketBehavior: 'new-session-frame',
  });
  const newSessionSettlement = await mod.releaseAioTerminalGuestPairExact({
    fetch: newSession.fetch,
    baseUrl: 'http://aio.test',
    taskId: 'release-task',
    pair: newSession.pair,
    timeoutMs: 100,
    socketFactory: newSession.socketFactory,
    markerFactory: () => 'identity00000000',
  });
  assert.deepEqual(newSessionSettlement, {
    kind: 'indeterminate',
    cause: 'identity-mismatch',
  });
  assert.equal(newSession.sockets.length, 1);
  assert.equal(newSession.sockets[0].sent.length, 0);

  const mismatch = createExactReleaseHarness({
    socketBehavior: 'identity-mismatch',
  });
  const mismatchSettlement = await mod.releaseAioTerminalGuestPairExact({
    fetch: mismatch.fetch,
    baseUrl: 'http://aio.test',
    taskId: 'release-task',
    pair: mismatch.pair,
    timeoutMs: 100,
    socketFactory: mismatch.socketFactory,
    markerFactory: () => 'identity00000001',
  });
  assert.deepEqual(mismatchSettlement, {
    kind: 'indeterminate',
    cause: 'identity-mismatch',
  });
  assert.equal(mismatch.sockets.length, 1);
  assert.equal(mismatch.sockets[0].sent.length, 0);

  const unknownRestore = createExactReleaseHarness({
    socketBehavior: 'restore-schema-mismatch',
  });
  const unknownRestoreSettlement = await mod.releaseAioTerminalGuestPairExact({
    fetch: unknownRestore.fetch,
    baseUrl: 'http://aio.test',
    taskId: 'release-task',
    pair: unknownRestore.pair,
    timeoutMs: 100,
    socketFactory: unknownRestore.socketFactory,
    markerFactory: () => 'identity00000004',
  });
  assert.deepEqual(unknownRestoreSettlement, {
    kind: 'indeterminate',
    cause: 'identity-mismatch',
  });
  assert.equal(unknownRestore.sockets[0].sent.length, 0);

  const duplicateRestore = createExactReleaseHarness({
    socketBehavior: 'duplicate-restored',
  });
  const duplicateRestoreSettlement =
    await mod.releaseAioTerminalGuestPairExact({
      fetch: duplicateRestore.fetch,
      baseUrl: 'http://aio.test',
      taskId: 'release-task',
      pair: duplicateRestore.pair,
      timeoutMs: 100,
      socketFactory: duplicateRestore.socketFactory,
      markerFactory: () => 'identity00000005',
    });
  assert.deepEqual(duplicateRestoreSettlement, {
    kind: 'indeterminate',
    cause: 'identity-mismatch',
  });
  assert.equal(duplicateRestore.sockets[0].sent.length, 1);

  // Frozen injected clock: the release's enqueue/phase deadline pre-checks
  // read `Date.now`, so on a stalled host a 10ms real budget could expire
  // before `socketFactory` ever ran and `sockets[0]` stayed undefined. With
  // the stubbed clock those pre-checks are deterministic, the injector socket
  // is always created, and the timeout settlement arrives solely through the
  // product's real reconnect timer that nothing races.
  await withManualReleaseClock(80_000_000, async () => {
    const missing = createExactReleaseHarness({ socketBehavior: 'silent' });
    let missingSocketCreated;
    const missingSocketCreation = new Promise((resolve) => {
      missingSocketCreated = resolve;
    });
    const missingKeepAlive = setTimeout(() => undefined, 30);
    const missingSettlement = await mod.releaseAioTerminalGuestPairExact({
      fetch: missing.fetch,
      baseUrl: 'http://aio.test',
      taskId: 'release-task',
      pair: missing.pair,
      timeoutMs: 10,
      socketFactory: (url, role) => {
        const socket = missing.socketFactory(url, role);
        missingSocketCreated();
        return socket;
      },
      markerFactory: () => 'identity00000002',
    });
    clearTimeout(missingKeepAlive);
    // Deterministic synchronization point: socket creation is awaited before
    // any assertion dereferences the created socket.
    await missingSocketCreation;
    assert.deepEqual(missingSettlement, {
      kind: 'indeterminate',
      cause: 'timeout',
    });
    assert.equal(missing.sockets[0].sent.length, 0);

    const echo = createExactReleaseHarness({ socketBehavior: 'echo-only' });
    let echoSocketCreated;
    const echoSocketCreation = new Promise((resolve) => {
      echoSocketCreated = resolve;
    });
    const echoKeepAlive = setTimeout(() => undefined, 30);
    const echoSettlement = await mod.releaseAioTerminalGuestPairExact({
      fetch: echo.fetch,
      baseUrl: 'http://aio.test',
      taskId: 'release-task',
      pair: echo.pair,
      timeoutMs: 10,
      socketFactory: (url, role) => {
        const socket = echo.socketFactory(url, role);
        echoSocketCreated();
        return socket;
      },
      markerFactory: () => 'identity00000003',
    });
    clearTimeout(echoKeepAlive);
    await echoSocketCreation;
    assert.deepEqual(echoSettlement, {
      kind: 'indeterminate',
      cause: 'timeout',
    });
    assert.equal(echo.sockets[0].sent.length, 2);
    assert.doesNotMatch(
      echo.sockets[0].sent[0].data,
      /CAP_AIO_INJECTOR_EXIT_identity00000003/u,
    );
  });
});

await test('pre-identity subscriber races retry without repeating any input', async () => {
  for (const firstBehavior of [
    'pre-identity-close',
    'pre-identity-error-frame',
  ]) {
    const harness = createExactReleaseHarness();
    const sockets = [];
    let injectorAttempts = 0;
    const nonces = ['retryinjector01', 'retrymain000001'];
    const settlement = await mod.releaseAioTerminalGuestPairExact({
      fetch: harness.fetch,
      baseUrl: 'http://aio.test',
      taskId: 'release-task',
      pair: harness.pair,
      timeoutMs: 500,
      socketFactory: (_url, role) => {
        const behavior =
          role === 'injector' && injectorAttempts++ === 0
            ? firstBehavior
            : 'success';
        const socket = new FakeReconnectSocket(role, harness.pair, behavior);
        sockets.push(socket);
        return socket;
      },
      markerFactory: () => nonces.shift(),
    });
    assert.deepEqual(
      settlement,
      { kind: 'confirmed', cause: null },
      firstBehavior,
    );
    assert.deepEqual(
      sockets.map(({ role }) => role),
      ['injector', 'injector', 'main'],
    );
    assert.equal(sockets[0].sent.length, 0);
    assert.ok(sockets.every((socket) => socket.terminated));
  }
});

await test('staged reconnect input waits for live ordered ACKs and fails closed before execute', async () => {
  // The release state machine (product `sendNextInputFrame` /
  // `maybeAdvanceInput`) sends staged frame N+1 only after frame N's write
  // callback and its live ACK observation, so staged emission order is
  // guaranteed — the ACK expectation below is therefore order-pinned per sent
  // frame (the exact ACK-request sequence, never a subset or a bare count).
  const stagedStageReadyAck = `CAP_AIO_INJECTOR_STAGE_${createHash('sha256')
    .update('CAP_AIO_INJECTOR_EXIT_staged00000001:stage:-1')
    .digest('hex')
    .slice(0, 24)}`;
  await withManualReleaseClock(90_000_000, async () => {
    for (const [socketBehavior, expectedCause, expectedAckRequests] of [
      ['stage-no-ack', 'timeout', [[], [stagedStageReadyAck]]],
      ['stage-restore-ack', 'timeout', [[], [stagedStageReadyAck]]],
      [
        'stage-duplicate-ack',
        'protocol-unconfirmed',
        [[], [stagedStageReadyAck]],
      ],
      [
        'stage-send-error',
        'protocol-unconfirmed',
        [[], [stagedStageReadyAck]],
      ],
      ['loop-failed', 'protocol-unconfirmed', [[]]],
    ]) {
      const harness = createExactReleaseHarness({ socketBehavior });
      let ackWindowClosed;
      const ackObservationWindowClosed = new Promise((resolve) => {
        ackWindowClosed = resolve;
      });
      const keepAlive = setTimeout(() => undefined, 50);
      const settlement = await mod.releaseAioTerminalGuestPairExact({
        fetch: harness.fetch,
        baseUrl: 'http://aio.test',
        taskId: 'release-task',
        pair: harness.pair,
        timeoutMs: 20,
        socketFactory: (url, role) => {
          const socket = harness.socketFactory(url, role);
          const close = socket.close.bind(socket);
          socket.close = () => {
            close();
            ackWindowClosed();
          };
          return socket;
        },
        markerFactory: () => 'staged00000001',
      });
      clearTimeout(keepAlive);
      // Deterministic ACK-observation synchronization point: the product has
      // closed its reconnect socket, so ACK adjudication is complete before
      // any staged-ACK assertion runs.
      await ackObservationWindowClosed;
      assert.deepEqual(
        settlement,
        {
          kind: 'indeterminate',
          cause: expectedCause,
        },
        socketBehavior,
      );
      assert.equal(harness.sockets.length, 1, socketBehavior);
      assert.deepEqual(
        harness.sockets[0].sent.map((frame) =>
          extractEchoSafeMarkers(frame.data),
        ),
        expectedAckRequests,
        socketBehavior,
      );
      assert.equal(
        harness.sockets[0].sent[0].data,
        `${harness.pair.closeToken}\n`,
      );
      assert.equal(harness.sockets[0].stagedReleasePayload, '');
      assert.ok(
        harness.sockets[0].sent.every(
          (frame) => Buffer.byteLength(frame.data, 'utf8') <= 1_024,
        ),
      );
    }
  });
});

await test('ACK and outcome duplicates remain rejected after more than 16KiB of intervening output', async () => {
  for (const socketBehavior of [
    'stage-duplicate-ack-after-window',
    'duplicate-state-after-window',
  ]) {
    const harness = createExactReleaseHarness({ socketBehavior });
    const settlement = await mod.releaseAioTerminalGuestPairExact({
      fetch: harness.fetch,
      baseUrl: 'http://aio.test',
      taskId: 'release-marker-window',
      pair: harness.pair,
      timeoutMs: 500,
      maxOutputBytes: 128 * 1_024,
      socketFactory: harness.socketFactory,
      markerFactory: () => 'windowduplicate1',
    });
    assert.deepEqual(
      settlement,
      { kind: 'indeterminate', cause: 'protocol-unconfirmed' },
      socketBehavior,
    );
    assert.equal(harness.sockets.length, 1, socketBehavior);
    assert.equal(harness.sockets[0].role, 'injector');
    assert.equal(harness.sockets[0].terminated, true);
    if (socketBehavior === 'stage-duplicate-ack-after-window') {
      assert.equal(harness.sockets[0].sent.length, 2);
    }
  }
});

await test('injector outcome is live-only, unique, and ordered before EXIT', async () => {
  for (const socketBehavior of [
    'state-restore-only',
    'exit-before-state',
    'duplicate-state',
    'both-states',
  ]) {
    const harness = createExactReleaseHarness({ socketBehavior });
    const settlement = await mod.releaseAioTerminalGuestPairExact({
      fetch: harness.fetch,
      baseUrl: 'http://aio.test',
      taskId: 'release-task',
      pair: harness.pair,
      timeoutMs: 100,
      socketFactory: harness.socketFactory,
      markerFactory: () => 'outcome00000001',
    });
    assert.deepEqual(
      settlement,
      { kind: 'indeterminate', cause: 'protocol-unconfirmed' },
      socketBehavior,
    );
    assert.equal(harness.sockets[0]?.role, 'injector');
  }
});

await test('an EXIT observed before the final send callback cannot confirm cleanup', async () => {
  const harness = createExactReleaseHarness({
    socketBehavior: 'execute-send-error',
  });
  const settlement = await mod.releaseAioTerminalGuestPairExact({
    fetch: harness.fetch,
    baseUrl: 'http://aio.test',
    taskId: 'release-task',
    pair: harness.pair,
    timeoutMs: 100,
    socketFactory: harness.socketFactory,
    markerFactory: () => 'execute00000001',
  });
  assert.deepEqual(settlement, {
    kind: 'indeterminate',
    cause: 'protocol-unconfirmed',
  });
  assert.equal(harness.sockets.length, 1);
  assert.ok(harness.sockets[0].sent.length > 3);
  assert.ok(harness.sockets[0].stagedReleasePayload.length > 0);
  assert.equal(
    harness.fetchCalls.filter((call) => call.path === '/v1/shell/exec').length,
    2,
  );
});

await test('exact reconnect release never detaches a recycled main TTY', async () => {
  const harness = createExactReleaseHarness({
    mainFingerprintState: 'confirmed-absent',
  });
  const settlement = await mod.releaseAioTerminalGuestPairExact({
    fetch: harness.fetch,
    baseUrl: 'http://aio.test',
    taskId: 'release-task',
    pair: harness.pair,
    timeoutMs: 500,
    socketFactory: harness.socketFactory,
    markerFactory: () => 'recycled00000001',
  });
  assert.deepEqual(settlement, { kind: 'confirmed', cause: null });
  assert.deepEqual(
    harness.sockets.map((socket) => socket.role),
    ['injector'],
  );
  assert.doesNotMatch(harness.sockets[0].sent[0].data, /detach-client/u);
  assert.equal(
    harness.sockets[0].sent[0].data.includes(harness.pair.main.tty),
    false,
  );
  assert.equal(
    spawnSync('bash', [
      '--noprofile',
      '--norc',
      '-n',
      '-c',
      harness.sockets[0].sent[0].data,
    ]).status,
    0,
  );

  const mismatch = createExactReleaseHarness({
    mainFingerprintState: 'identity-mismatch',
  });
  const mismatchSettlement = await mod.releaseAioTerminalGuestPairExact({
    fetch: mismatch.fetch,
    baseUrl: 'http://aio.test',
    taskId: 'release-task',
    pair: mismatch.pair,
    timeoutMs: 100,
    socketFactory: mismatch.socketFactory,
  });
  assert.deepEqual(mismatchSettlement, {
    kind: 'indeterminate',
    cause: 'identity-mismatch',
  });
  assert.equal(mismatch.sockets.length, 2);
});

await test('batched proof safely converges already-absent and detached-main partial states', async () => {
  const alreadyAbsent = createExactReleaseHarness({
    socketBehavior: 'new-session-frame',
    mainFingerprintState: 'confirmed-absent',
    injectorFingerprintState: 'confirmed-absent',
  });
  assert.deepEqual(
    await mod.releaseAioTerminalGuestPairExact({
      fetch: alreadyAbsent.fetch,
      baseUrl: 'http://aio.test',
      taskId: 'release-task',
      pair: alreadyAbsent.pair,
      timeoutMs: 500,
      socketFactory: alreadyAbsent.socketFactory,
      markerFactory: () => 'absent00000001',
    }),
    { kind: 'confirmed', cause: null },
  );
  assert.deepEqual(
    alreadyAbsent.sockets.map(({ role }) => role),
    ['injector'],
  );

  const detachedMain = createExactReleaseHarness({
    injectorSocketBehavior: 'new-session-frame',
    mainSocketBehavior: 'success',
    mainFingerprintState: 'exact-present',
    injectorFingerprintState: 'confirmed-absent',
  });
  const recoveryNonces = ['recoverinjector', 'recovermain00001'];
  const detachedSettlement =
    await mod.releaseAioTerminalGuestPairExact({
      fetch: detachedMain.fetch,
      baseUrl: 'http://aio.test',
      taskId: 'release-task',
      pair: detachedMain.pair,
      timeoutMs: 500,
      socketFactory: detachedMain.socketFactory,
      markerFactory: () => recoveryNonces.shift(),
    });
  assert.deepEqual(
    detachedSettlement,
    { kind: 'confirmed', cause: null },
    JSON.stringify({
      calls: detachedMain.fetchCalls.map(({ path, method }) => ({
        path,
        method,
      })),
      sockets: detachedMain.sockets.map(({ role, sent }) => ({
        role,
        sent: sent.length,
      })),
    }),
  );
  assert.deepEqual(
    detachedMain.sockets.map(({ role }) => role),
    ['injector', 'main'],
  );
  assert.equal(
    detachedMain.fetchCalls.filter(({ path }) => path === '/v1/shell/exec')
      .length,
    2,
  );
});

await test('default partial recovery fits the simulated slow REST budget in one drained control session', async () => {
  let clock;
  const events = [];
  const execSessionIds = [];
  const proofCommands = [];
  let controlSessionId;
  const pair = ownershipPair({
    mainSessionId: canonicalProviderSessionId(450),
    injectorSessionId: canonicalProviderSessionId(451),
    slot: 450,
    closeNonce: 'budgetrecover01',
  });
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (url.pathname === '/v1/shell/sessions/create') {
      clock.advance(800);
      controlSessionId = body.id;
      events.push('create');
      return response(200, {
        success: true,
        data: { session_id: body.id, working_dir: '/home/gem' },
      });
    }
    if (url.pathname === '/v1/shell/exec') {
      const pass = proofCommands.length;
      clock.advance(pass === 0 ? 800 : 3_250);
      events.push(`exec-${pass + 1}`);
      execSessionIds.push(body.id);
      proofCommands.push(unwrapSingleQuotedShLc(body.command));
      const nonce = /cap_verify_pair '([A-Za-z0-9]{8,64})' '[01]'/u.exec(
        proofCommands.at(-1),
      )?.[1];
      return response(200, {
        success: true,
        data: {
          session_id: body.id,
          command: body.command,
          status: 'completed',
          exit_code: 0,
          output:
            pass === 0
              ? `CAP_AIO_PAIR_MAIN_RECOVERABLE_${nonce}\n`
              : `CAP_AIO_PAIR_CONFIRMED_${nonce}\n`,
        },
      });
    }
    if (
      init.method === 'DELETE' &&
      url.pathname.startsWith('/v1/shell/sessions/')
    ) {
      clock.advance(4_575);
      events.push('delete');
      const sessionId = decodeURIComponent(
        url.pathname.slice('/v1/shell/sessions/'.length),
      );
      return response(200, {
        success: true,
        data: { session_id: sessionId },
      });
    }
    throw new Error('unexpected budget request');
  };
  const releaseNonces = ['budgetinjector1', 'budgetmain00001'];
  let settlement;
  await withManualReleaseClock(10_000_000, async (manualClock) => {
    clock = manualClock;
    settlement = await mod.releaseAioTerminalGuestPairExact({
      fetch,
      baseUrl: 'http://aio.test',
      taskId: 'budget-recovery',
      pair,
      socketFactory: (_url, role) => {
        clock.advance(role === 'injector' ? 500 : 2_000);
        return new FakeReconnectSocket(
          role,
          pair,
          role === 'injector' ? 'new-session-frame' : 'success',
        );
      },
      markerFactory: () => releaseNonces.shift(),
    });
  });
  assert.deepEqual(settlement, { kind: 'confirmed', cause: null });
  assert.equal(clock.elapsed(), 11_925);
  assert.ok(clock.elapsed() < 20_000);
  assert.deepEqual(events, ['create', 'exec-1', 'exec-2', 'delete']);
  assert.deepEqual(execSessionIds, [controlSessionId, controlSessionId]);
  assert.equal(proofCommands.length, 2);
  assert.match(proofCommands[0], /while \[ "\$cap_i" -lt 1 \]/u);
  assert.match(proofCommands[1], /while \[ "\$cap_i" -lt 50 \]/u);
  for (const command of proofCommands) {
    assert.match(command, new RegExp(pair.main.pid, 'u'));
    assert.match(command, new RegExp(pair.injector.pid, 'u'));
    assert.match(command, /tmux list-clients/u);
  }
});

await test('exact reconnect release shares one deadline across every phase', async () => {
  const harness = createExactReleaseHarness();
  await withManualReleaseClock(50_000_000, async (clock) => {
    const fetch = async (input, init) => {
      // The REST proof spends a simulated 55ms of the shared 40ms budget on
      // the injected clock, so the single-deadline overrun is decided by
      // deadline arithmetic instead of a real slow response racing the host.
      if (new URL(String(input)).pathname === '/v1/shell/exec') {
        clock.advance(55);
      }
      return harness.fetch(input, init);
    };
    const settlement = await mod.releaseAioTerminalGuestPairExact({
      fetch,
      baseUrl: 'http://aio.test',
      taskId: 'release-task',
      pair: harness.pair,
      timeoutMs: 40,
      socketFactory: harness.socketFactory,
      markerFactory: () => 'deadline00000001',
    });
    const elapsedMs = clock.elapsed();
    assert.deepEqual(settlement, {
      kind: 'indeterminate',
      cause: 'timeout',
    });
    assert.ok(elapsedMs >= 30 && elapsedMs < 75, `elapsed=${elapsedMs}`);
  });
  assert.deepEqual(harness.sockets.map((socket) => socket.role), [
    'injector',
    'main',
  ]);
});

await test('exact release requires the provider to echo the exact child-shell command', async () => {
  for (const responseCommandTransform of [
    (command) => command.replace(/^sh -lc /u, ''),
    (command) => `${command} `,
  ]) {
    const harness = createExactReleaseHarness({ responseCommandTransform });
    const settlement = await mod.releaseAioTerminalGuestPairExact({
      fetch: harness.fetch,
      baseUrl: 'http://aio.test',
      taskId: 'release-task',
      pair: harness.pair,
      timeoutMs: 500,
      socketFactory: harness.socketFactory,
      markerFactory: () => 'wrapped00000001',
    });
    assert.deepEqual(settlement, {
      kind: 'indeterminate',
      cause: 'protocol-unconfirmed',
    });
    assert.equal(harness.sockets.length, 2);
  }
});

await test('batched proof rejects duplicate, conflicting, and unknown proof markers', async () => {
  for (const proofOutputTransform of [
    (output) => `${output}${output}`,
    (output) =>
      `${output}${output.replace('PAIR_CONFIRMED', 'PAIR_UNCONFIRMED')}`,
    (output) => `${output}CAP_AIO_PAIR_UNKNOWN_unknown00000001\n`,
  ]) {
    const harness = createExactReleaseHarness({ proofOutputTransform });
    const settlement = await mod.releaseAioTerminalGuestPairExact({
      fetch: harness.fetch,
      baseUrl: 'http://aio.test',
      taskId: 'release-task',
      pair: harness.pair,
      timeoutMs: 500,
      socketFactory: harness.socketFactory,
      markerFactory: (() => {
        const nonces = ['proofinjector01', 'proofmain000001'];
        return () => nonces.shift();
      })(),
    });
    assert.deepEqual(settlement, {
      kind: 'indeterminate',
      cause: 'protocol-unconfirmed',
    });
  }
});

await test('batched proof ignores non-protocol login-shell command echo', async () => {
  const harness = createExactReleaseHarness({
    proofOutputTransform: (output) =>
      `sh -lc 'echoed cohort command with CAP_AIO_PAIR_CONFIRMED_%s'\n` +
      `ordinary provider prompt text\n${output}`,
  });
  const settlement = await mod.releaseAioTerminalGuestPairExact({
    fetch: harness.fetch,
    baseUrl: 'http://aio.test',
    taskId: 'release-task',
    pair: harness.pair,
    timeoutMs: 500,
    socketFactory: harness.socketFactory,
    markerFactory: (() => {
      const nonces = ['echoinjector01', 'echomain000001'];
      return () => nonces.shift();
    })(),
  });
  assert.deepEqual(settlement, { kind: 'confirmed', cause: null });
});

await test('exact reconnect release fails closed on identity, output, timeout, and REST proof uncertainty', async () => {
  for (const [socketBehavior, expectedCause, maxOutputBytes, proofCount] of [
    ['identity-mismatch', 'identity-mismatch', 4_096, 2],
    ['output-limit', 'output-limit', 128, 1],
    ['send-error', 'protocol-unconfirmed', 4_096, 2],
  ]) {
    const harness = createExactReleaseHarness({ socketBehavior });
    const settlement = await mod.releaseAioTerminalGuestPairExact({
      fetch: harness.fetch,
      baseUrl: 'http://aio.test',
      taskId: 'release-task',
      pair: harness.pair,
      timeoutMs: 100,
      maxOutputBytes,
      socketFactory: harness.socketFactory,
      markerFactory: () => 'release00000001',
    });
    assert.deepEqual(settlement, {
      kind: 'indeterminate',
      cause: expectedCause,
    });
    assert.equal(
      harness.fetchCalls.filter((call) => call.path === '/v1/shell/exec')
        .length,
      proofCount,
      socketBehavior,
    );
    assert.equal(
      harness.sockets.every((socket) =>
        socketBehavior === 'identity-mismatch'
          ? socket.sent.length === 0
          : socket.sent.length >= 1,
      ),
      true,
    );
  }

  const timeoutHarness = createExactReleaseHarness({ socketBehavior: 'silent' });
  const keepAlive = setTimeout(() => undefined, 20);
  const timedOut = await mod.releaseAioTerminalGuestPairExact({
    fetch: timeoutHarness.fetch,
    baseUrl: 'http://aio.test',
    taskId: 'release-task',
    pair: timeoutHarness.pair,
    timeoutMs: 5,
    socketFactory: timeoutHarness.socketFactory,
    markerFactory: () => 'release00000001',
  });
  clearTimeout(keepAlive);
  assert.deepEqual(timedOut, { kind: 'indeterminate', cause: 'timeout' });

  const restMismatch = createExactReleaseHarness({ verificationExitCode: 78 });
  const restSettlement = await mod.releaseAioTerminalGuestPairExact({
    fetch: restMismatch.fetch,
    baseUrl: 'http://aio.test',
    taskId: 'release-task',
    pair: restMismatch.pair,
    timeoutMs: 500,
    socketFactory: restMismatch.socketFactory,
    markerFactory: (() => {
      const nonces = ['injector00000001', 'main00000001'];
      return () => nonces.shift();
    })(),
  });
  assert.deepEqual(restSettlement, {
    kind: 'indeterminate',
    cause: 'identity-mismatch',
  });

  let called = false;
  const invalid = await mod.releaseAioTerminalGuestPairExact({
    fetch: async () => {
      called = true;
      throw new Error('must not run');
    },
    baseUrl: 'not-a-url',
    taskId: 'invalid/task',
    pair: ownershipPair({
      mainSessionId: 'same-session',
      injectorSessionId: 'same-session',
    }),
  });
  assert.deepEqual(invalid, {
    kind: 'indeterminate',
    cause: 'identity-mismatch',
  });
  assert.equal(called, false);
});

await test('stale sweep without an injected releaser uses the production exact reconnect path', async () => {
  const stalePair = ownershipPair({
    mainSessionId: '33333333-3333-4333-8333-333333333333',
    injectorSessionId: '44444444-4444-4444-8444-444444444444',
    slot: 91,
    closeNonce: 'default00000001',
  });
  const record = ownershipRecord({
    pair: stalePair,
    processFingerprint: 'b'.repeat(64),
    ivByte: 9,
  });
  const journal = createJournalFetch({
    records: new Map([[record.path, record.content]]),
  });
  const socketRoles = [];
  const nonces = ['injector00000001', 'main00000001'];
  const settlement = await mod.sweepAioStaleTerminalSessions({
    fetch: journal.fetch,
    baseUrl: 'http://aio.test',
    scope: scope(),
    processFingerprint: 'a'.repeat(64),
    timing: {
      exactReleaseTimeoutMs: 500,
      reconnectOutputMaxBytes: 4_096,
      cleanupRetryDelayMs: 0,
    },
    reconnectSocketFactory: (url, role) => {
      assert.equal(
        new URL(url).searchParams.get('session_id'),
        role === 'main'
          ? stalePair.mainSessionId
          : stalePair.injectorSessionId,
      );
      socketRoles.push(role);
      return new FakeReconnectSocket(role, stalePair);
    },
    releaseMarkerFactory: () => nonces.shift(),
  });
  assert.deepEqual(settlement, {
    kind: 'confirmed',
    cause: null,
    inspectedRecords: 1,
    unrelatedRecords: 0,
    peerRecords: 0,
    staleRecords: 1,
    confirmedIdentities: 2,
    deletedIdentities: 2,
    alreadyAbsentIdentities: 0,
    removedRecords: 1,
  });
  assert.deepEqual(socketRoles, ['injector', 'main']);
  assert.equal(
    JSON.stringify(settlement).includes(stalePair.mainSessionId),
    false,
  );
});

await test('absent guest fingerprints with an attached recorded main TTY remain unconfirmed and retain metadata', async () => {
  const pair = ownershipPair({
    mainSessionId: canonicalProviderSessionId(241),
    injectorSessionId: canonicalProviderSessionId(242),
    slot: 241,
    closeNonce: 'attachedtty00001',
  });
  const exactHarness = createExactReleaseHarness({
    pair,
    mainFingerprintState: 'confirmed-absent',
    injectorFingerprintState: 'confirmed-absent',
    mainTtyState: 'attached',
  });
  const exactSettlement = await mod.releaseAioTerminalGuestPairExact({
    fetch: exactHarness.fetch,
    baseUrl: 'http://aio.test',
    taskId: scope().taskId,
    pair,
    timeoutMs: 500,
    maxOutputBytes: 4_096,
    socketFactory: exactHarness.socketFactory,
    markerFactory: () => 'attachedtty00002',
  });
  assert.deepEqual(exactSettlement, {
    kind: 'indeterminate',
    cause: 'protocol-unconfirmed',
  });
  assert.deepEqual(
    exactHarness.sockets.map(({ role }) => role),
    ['injector'],
    'the reconnect protocol did not model both original guest fingerprints absent',
  );
  assert.equal(
    exactHarness.fetchCalls.some(
      ({ path, method }) =>
        method === 'DELETE' &&
        [pair.mainSessionId, pair.injectorSessionId].some((providerSessionId) =>
          path.endsWith(`/${encodeURIComponent(providerSessionId)}`),
        ),
    ),
    false,
    'an unconfirmed exact release deleted business provider-session metadata',
  );

  const record = ownershipRecord({
    pair,
    processFingerprint: 'b'.repeat(64),
    ivByte: 31,
  });
  const records = new Map([[record.path, record.content]]);
  const journal = createJournalFetch({
    records,
    mainTtyState: 'attached',
  });
  const socketRoles = [];
  const sweepSettlement = await mod.sweepAioStaleTerminalSessions({
    fetch: journal.fetch,
    baseUrl: 'http://aio.test',
    scope: scope(),
    processFingerprint: 'a'.repeat(64),
    timing: {
      exactReleaseTimeoutMs: 500,
      reconnectOutputMaxBytes: 4_096,
      cleanupRetryDelayMs: 0,
    },
    reconnectSocketFactory: (url, role) => {
      assert.equal(
        new URL(url).searchParams.get('session_id'),
        role === 'main' ? pair.mainSessionId : pair.injectorSessionId,
      );
      socketRoles.push(role);
      return new FakeReconnectSocket(
        role,
        pair,
        role === 'injector' ? 'main-absent' : 'success',
      );
    },
    releaseMarkerFactory: () => 'attachedtty00003',
  });
  assert.deepEqual(sweepSettlement, {
    kind: 'indeterminate',
    cause: 'cleanup-unconfirmed',
    inspectedRecords: 1,
    unrelatedRecords: 0,
    peerRecords: 0,
    staleRecords: 1,
    confirmedIdentities: 0,
    deletedIdentities: 0,
    alreadyAbsentIdentities: 0,
    removedRecords: 0,
  });
  assert.deepEqual(socketRoles, ['injector']);
  const proofCall = journal.calls.find(
    ({ path, body }) =>
      path === '/v1/shell/exec' && body?.command.includes('cap_verify_pair()'),
  );
  assert.ok(proofCall);
  assert.match(proofCall.body.command, /cap_tty_state/u);
  assert.equal(proofCall.body.command.includes(pair.main.tty), true);
  assert.equal(
    journal.calls.some(
      ({ path, method }) =>
        method === 'DELETE' &&
        path.startsWith('/v1/shell/sessions/') &&
        [pair.mainSessionId, pair.injectorSessionId].some((providerSessionId) =>
          path.endsWith(`/${encodeURIComponent(providerSessionId)}`),
        ),
    ),
    false,
    'the stale sweep deleted provider metadata after an unconfirmed TTY proof',
  );
  assert.equal(
    journal.calls.some(
      ({ path, body }) =>
        path === '/v1/shell/exec' && body?.command.startsWith('rm -f -- '),
    ),
    false,
    'the stale sweep removed the ownership record after an unconfirmed TTY proof',
  );
  assert.equal(records.has(record.path), true);
});

await test('production stale sweep serializes shell exec across multiple stale pairs', async () => {
  const pairs = [
    ownershipPair({
      mainSessionId: canonicalProviderSessionId(151),
      injectorSessionId: canonicalProviderSessionId(152),
      slot: 151,
      closeNonce: 'serial00000001',
    }),
    ownershipPair({
      mainSessionId: canonicalProviderSessionId(153),
      injectorSessionId: canonicalProviderSessionId(154),
      slot: 153,
      closeNonce: 'serial00000002',
    }),
  ];
  const records = pairs.map((pair, index) =>
    ownershipRecord({
      pair,
      processFingerprint: 'b'.repeat(64),
      ivByte: 10 + index,
    }),
  );
  const journal = createJournalFetch({
    records: new Map(records.map((record) => [record.path, record.content])),
  });
  let activeShellExec = 0;
  let maxActiveShellExec = 0;
  const serializedFetch = async (input, init = {}) => {
    const isShellExec =
      new URL(String(input)).pathname === '/v1/shell/exec';
    if (!isShellExec) return journal.fetch(input, init);
    activeShellExec += 1;
    maxActiveShellExec = Math.max(maxActiveShellExec, activeShellExec);
    await new Promise((resolve) => setTimeout(resolve, 2));
    try {
      return await journal.fetch(input, init);
    } finally {
      activeShellExec -= 1;
    }
  };
  const pairBySessionId = new Map(
    pairs.flatMap((pair) => [
      [pair.mainSessionId, pair],
      [pair.injectorSessionId, pair],
    ]),
  );
  const nonces = [
    'serialinjector0001',
    'serialmain00000001',
    'serialinjector0002',
    'serialmain00000002',
  ];
  const settlement = await mod.sweepAioStaleTerminalSessions({
    fetch: serializedFetch,
    baseUrl: 'http://aio.test',
    scope: scope(),
    processFingerprint: 'a'.repeat(64),
    timing: {
      exactReleaseTimeoutMs: 1_000,
      reconnectOutputMaxBytes: 4_096,
      cleanupRetryDelayMs: 0,
    },
    reconnectSocketFactory: (url, role) => {
      const providerSessionId = new URL(url).searchParams.get('session_id');
      const pair = pairBySessionId.get(providerSessionId);
      assert.ok(pair);
      assert.equal(
        providerSessionId,
        role === 'main' ? pair.mainSessionId : pair.injectorSessionId,
      );
      return new FakeReconnectSocket(role, pair);
    },
    releaseMarkerFactory: () => nonces.shift(),
  });
  assert.equal(settlement.kind, 'confirmed');
  assert.equal(settlement.staleRecords, 2);
  assert.equal(settlement.confirmedIdentities, 4);
  assert.equal(settlement.removedRecords, 2);
  assert.equal(maxActiveShellExec, 1);
  assert.equal(activeShellExec, 0);
});

await test('serialized stale release retains one bounded cleanup deadline', async () => {
  const pairs = [
    ownershipPair({
      mainSessionId: canonicalProviderSessionId(161),
      injectorSessionId: canonicalProviderSessionId(162),
      slot: 161,
      closeNonce: 'budget00000001',
    }),
    ownershipPair({
      mainSessionId: canonicalProviderSessionId(163),
      injectorSessionId: canonicalProviderSessionId(164),
      slot: 163,
      closeNonce: 'budget00000002',
    }),
  ];
  const records = pairs.map((pair, index) =>
    ownershipRecord({
      pair,
      processFingerprint: 'b'.repeat(64),
      ivByte: 20 + index,
    }),
  );
  const journal = createJournalFetch({
    records: new Map(records.map((record) => [record.path, record.content])),
  });
  const releaseTimeouts = [];
  let settlement;
  let elapsedMs;
  await withManualReleaseClock(60_000_000, async (clock) => {
    settlement = await mod.sweepAioStaleTerminalSessions({
      fetch: journal.fetch,
      baseUrl: 'http://aio.test',
      scope: scope(),
      processFingerprint: 'a'.repeat(64),
      timing: {
        exactReleaseTimeoutMs: 12,
        cleanupRetryDelayMs: 0,
      },
      guestPairReleaser: async ({ timeoutMs }) => {
        releaseTimeouts.push(timeoutMs);
        // Overspending the granted slice on the injected clock exhausts the
        // one bounded cleanup deadline deterministically.
        clock.advance(timeoutMs + 2);
        return { kind: 'confirmed', cause: null };
      },
    });
    elapsedMs = clock.elapsed();
  });
  assert.equal(settlement.kind, 'indeterminate');
  assert.equal(settlement.cause, 'cleanup-unconfirmed');
  assert.equal(settlement.staleRecords, 2);
  assert.equal(settlement.confirmedIdentities, 2);
  assert.equal(settlement.removedRecords, 0);
  assert.equal(releaseTimeouts.length, 1);
  assert.ok(releaseTimeouts[0] > 0 && releaseTimeouts[0] <= 12);
  assert.ok(elapsedMs < 100, `elapsed=${elapsedMs}`);
});

await test('startup sweep deletes only authenticated stale records and preserves peers, other scopes, and ordinary sessions', async () => {
  const currentProcess = 'a'.repeat(64);
  const oldProcess = 'b'.repeat(64);
  const ownershipScope = scope();
  const unrelatedScope = scope({
    taskId: 'other-task',
    providerSandboxId: 'other-sandbox',
    ownership: {
      ownerGeneration: 'other-owner',
      // Same physical resource key lets the reader authenticate and classify
      // this as unrelated rather than treating it as corrupted ciphertext.
      resourceGeneration: ownershipScope.ownership.resourceGeneration,
    },
  });
  const staleDeletedId = canonicalProviderSessionId(111);
  const staleAbsentId = canonicalProviderSessionId(112);
  const peerId = canonicalProviderSessionId(113);
  const unrelatedId = canonicalProviderSessionId(114);
  const ordinaryCommandId = 'ordinary-rest-command-must-survive';
  const recordsByKind = {
    staleDeleted: ownershipRecord({
      providerSessionId: staleDeletedId,
      ownershipScope,
      processFingerprint: oldProcess,
      role: 'main',
      ivByte: 1,
    }),
    staleAbsent: ownershipRecord({
      providerSessionId: staleAbsentId,
      ownershipScope,
      processFingerprint: oldProcess,
      role: 'injector',
      ivByte: 2,
    }),
    peer: ownershipRecord({
      providerSessionId: peerId,
      ownershipScope,
      processFingerprint: currentProcess,
      ivByte: 3,
    }),
    unrelated: ownershipRecord({
      providerSessionId: unrelatedId,
      ownershipScope: unrelatedScope,
      processFingerprint: oldProcess,
      ivByte: 4,
    }),
  };
  const records = new Map(
    Object.values(recordsByKind).map((record) => [record.path, record.content]),
  );
  const harness = createJournalFetch({
    records,
    deleteModes: new Map([[staleAbsentId, 'absent']]),
  });

  const settlement = await mod.sweepAioStaleTerminalSessions({
    fetch: harness.fetch,
    baseUrl: 'http://aio.test/',
    scope: ownershipScope,
    processFingerprint: currentProcess,
    timing: { cleanupRetryDelayMs: 0 },
    guestPairReleaser: confirmedGuestPairReleaser,
  });
  assert.deepEqual(settlement, {
    kind: 'confirmed',
    cause: null,
    inspectedRecords: 4,
    unrelatedRecords: 1,
    peerRecords: 1,
    staleRecords: 2,
    confirmedIdentities: 4,
    deletedIdentities: 3,
    alreadyAbsentIdentities: 1,
    removedRecords: 2,
  });

  const stalePairIds = [
    staleDeletedId,
    canonicalProviderSessionId(501),
    canonicalProviderSessionId(502),
    staleAbsentId,
  ];
  const businessDeletes = harness.calls
    .filter(
      (call) =>
        call.method === 'DELETE' &&
        [...stalePairIds, peerId, unrelatedId, ordinaryCommandId].includes(
          decodeURIComponent(call.path.slice('/v1/shell/sessions/'.length)),
        ),
    )
    .map((call) =>
      decodeURIComponent(call.path.slice('/v1/shell/sessions/'.length)),
    );
  assert.deepEqual(businessDeletes.sort(), stalePairIds.sort());
  assert.equal(businessDeletes.includes(peerId), false);
  assert.equal(businessDeletes.includes(unrelatedId), false);
  assert.equal(businessDeletes.includes(ordinaryCommandId), false);

  const journalCleanup = harness.calls.find(
    (call) => call.path === '/v1/shell/exec',
  ).body.command;
  assert.match(journalCleanup, /^rm -f -- /u);
  assert.equal(journalCleanup.includes(recordsByKind.staleDeleted.path), true);
  assert.equal(journalCleanup.includes(recordsByKind.staleAbsent.path), true);
  assert.equal(journalCleanup.includes(recordsByKind.peer.path), false);
  assert.equal(journalCleanup.includes(recordsByKind.unrelated.path), false);
  const serializedSettlement = JSON.stringify(settlement);
  for (const identity of [
    staleDeletedId,
    staleAbsentId,
    peerId,
    unrelatedId,
    ownershipScope.providerSandboxId,
    ownershipScope.ownership.resourceGeneration,
  ]) {
    assert.equal(serializedSettlement.includes(identity), false);
  }
});

await test('tampered or malformed journal state blocks every destructive call', async () => {
  const oldProcess = 'b'.repeat(64);
  const ownershipScope = scope();
  const record = ownershipRecord({
    providerSessionId: canonicalProviderSessionId(121),
    ownershipScope,
    processFingerprint: oldProcess,
  });
  const final = record.content.at(-1);
  const tampered = `${record.content.slice(0, -1)}${final === 'a' ? 'b' : 'a'}`;
  const harness = createJournalFetch({
    records: new Map([[record.path, tampered]]),
  });
  const settlement = await mod.sweepAioStaleTerminalSessions({
    fetch: harness.fetch,
    baseUrl: 'http://aio.test',
    scope: ownershipScope,
    processFingerprint: 'a'.repeat(64),
  });
  assert.deepEqual(settlement, {
    kind: 'indeterminate',
    cause: 'journal-invalid',
    inspectedRecords: 1,
    unrelatedRecords: 0,
    peerRecords: 0,
    staleRecords: 0,
    confirmedIdentities: 0,
    deletedIdentities: 0,
    alreadyAbsentIdentities: 0,
    removedRecords: 0,
  });
  assert.equal(harness.calls.some((call) => call.method === 'DELETE'), false);
  assert.equal(harness.calls.some((call) => call.path === '/v1/shell/exec'), false);
});

await test('journal list protocol rejects malformed, ambiguous, and oversized inventories before reads', async () => {
  const peerRecord = ownershipRecord({
    providerSessionId: canonicalProviderSessionId(122),
    processFingerprint: 'a'.repeat(64),
  });
  const journalDir = peerRecord.path.slice(0, peerRecord.path.lastIndexOf('/'));
  const validEntry = journalEntry(peerRecord.path, peerRecord.content);
  const invalidBodies = [
    null,
    { success: false, data: null },
    { success: true, data: null },
    listResult('/wrong-path', []),
    { success: true, data: { path: journalDir, files: null } },
    listResult(journalDir, Array.from({ length: 129 }, () => validEntry)),
    listResult(journalDir, [null]),
    listResult(journalDir, [{ ...validEntry, name: 7 }]),
    listResult(journalDir, [{ ...validEntry, path: 7 }]),
    listResult(journalDir, [{ ...validEntry, is_directory: true }]),
    listResult(journalDir, [{ ...validEntry, size: '1' }]),
    listResult(journalDir, [{ ...validEntry, size: 0 }]),
    listResult(journalDir, [{ ...validEntry, size: 16_385 }]),
    listResult(journalDir, [{ ...validEntry, name: 'unknown.txt' }]),
    listResult(journalDir, [{ ...validEntry, path: `${journalDir}/wrong.owner` }]),
    listResult(journalDir, [validEntry, validEntry]),
    listResult(journalDir, [], { total_count: 1 }),
    listResult(journalDir, [], { file_count: 1.5 }),
    listResult(journalDir, [], { directory_count: 1 }),
  ];
  for (const body of invalidBodies) {
    const { settlement, calls } = await sweepWithProtocol({ listBody: body });
    assert.equal(settlement.kind, 'indeterminate');
    assert.ok(
      settlement.cause === 'journal-invalid' ||
        settlement.cause === 'journal-unconfirmed',
    );
    assert.equal(calls.some((call) => call.path === '/v1/file/read'), false);
  }

  for (const missingBody of [
    { success: false, data: null, message: 'No such file' },
    { success: false, message: 'directory does not exist' },
  ]) {
    const { settlement } = await sweepWithProtocol({ listBody: missingBody });
    assert.equal(settlement.kind, 'confirmed');
    assert.equal(settlement.inspectedRecords, 0);
  }
  for (const ambiguousBody of [
    { success: false, data: {}, message: 'No such file' },
    { success: false, data: null, message: 7 },
    { success: false, data: null, message: 'permission denied' },
  ]) {
    const { settlement } = await sweepWithProtocol({ listBody: ambiguousBody });
    assert.equal(settlement.kind, 'indeterminate');
    assert.equal(settlement.cause, 'journal-unconfirmed');
  }
  assert.equal(
    (
      await sweepWithProtocol({
        listStatus: 404,
        listBody: { success: true, data: { path: journalDir, files: [] } },
      })
    ).settlement.cause,
    'journal-unconfirmed',
  );
  assert.equal(
    (await sweepWithProtocol({ listJsonReject: true })).settlement.cause,
    'journal-unconfirmed',
  );

  for (const size of [undefined, null]) {
    const entry = { ...validEntry, size };
    const { settlement } = await sweepWithProtocol({
      listBody: listResult(journalDir, [entry], {
        total_count: undefined,
        file_count: null,
        directory_count: 0,
      }),
      readBody: {
        success: true,
        data: { file: peerRecord.path, content: `${peerRecord.content}\r\n` },
      },
    });
    assert.equal(settlement.kind, 'confirmed');
    assert.equal(settlement.peerRecords, 1);
  }
});

await test('journal reads distinguish transport uncertainty from authenticated invalid content', async () => {
  const peerRecord = ownershipRecord({
    providerSessionId: canonicalProviderSessionId(123),
    processFingerprint: 'a'.repeat(64),
  });
  const journalDir = peerRecord.path.slice(0, peerRecord.path.lastIndexOf('/'));
  const listBody = listResult(journalDir, [
    journalEntry(peerRecord.path, peerRecord.content),
  ]);
  const uncertainReads = [
    { readStatus: 503, readBody: null },
    { readBody: null },
    { readBody: { success: false, data: null } },
  ];
  for (const read of uncertainReads) {
    const { settlement } = await sweepWithProtocol({ listBody, ...read });
    assert.equal(settlement.kind, 'indeterminate');
    assert.equal(settlement.cause, 'journal-unconfirmed');
  }
  assert.equal(
    (await sweepWithProtocol({ listBody, readReject: true })).settlement.cause,
    'journal-unconfirmed',
  );

  const invalidReadBodies = [
    { success: true, data: null },
    { success: true, data: { file: '/wrong', content: peerRecord.content } },
    { success: true, data: { file: peerRecord.path, content: 7 } },
    { success: true, data: { file: peerRecord.path, content: '' } },
    { success: true, data: { file: peerRecord.path, content: 'x'.repeat(8_193) } },
    { success: true, data: { file: peerRecord.path, content: 'x\ny' } },
    { success: true, data: { file: peerRecord.path, content: 'x\ry' } },
    { success: true, data: { file: peerRecord.path, content: 'not-a-record' } },
  ];
  for (const readBody of invalidReadBodies) {
    const { settlement } = await sweepWithProtocol({ listBody, readBody });
    assert.equal(settlement.kind, 'indeterminate');
    assert.equal(settlement.cause, 'journal-invalid');
  }

  const renamedPath = `${journalDir}/${'0'.repeat(64)}.owner`;
  const { settlement: renamed } = await sweepWithProtocol({
    listBody: listResult(journalDir, [
      journalEntry(renamedPath, peerRecord.content),
    ]),
    readBody: {
      success: true,
      data: { file: renamedPath, content: peerRecord.content },
    },
  });
  assert.equal(renamed.cause, 'journal-invalid');
});

await test('authenticated ciphertext whose identity digest disagrees with its filename is rejected', async () => {
  const ownershipScope = scope();
  const reference = ownershipRecord({
    providerSessionId: canonicalProviderSessionId(124),
    ownershipScope,
    processFingerprint: 'a'.repeat(64),
  });
  const fields = reference.content.split(':');
  const version = fields[0];
  const fakeFingerprint = '0'.repeat(64);
  const processFingerprint = 'a'.repeat(64);
  const iv = Buffer.alloc(12, 9);
  const canonical = (values) =>
    values.map((value) => `${Buffer.byteLength(value, 'utf8')}:${value}`).join('|');
  const key = createHash('sha256')
    .update(
      canonical([
        version,
        'encryption-key',
        ownershipScope.ownership.resourceGeneration,
      ]),
    )
    .digest();
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(
    Buffer.from(
      canonical([
        version,
        fakeFingerprint,
        fields[1],
        fields[2],
        processFingerprint,
      ]),
    ),
  );
  const validButDigestMismatchedPair = JSON.stringify(
    ownershipPair({
      mainSessionId: canonicalProviderSessionId(141),
      injectorSessionId: canonicalProviderSessionId(142),
    }),
  );
  const ciphertext = Buffer.concat([
    cipher.update(validButDigestMismatchedPair, 'utf8'),
    cipher.final(),
  ]);
  const forgedContent = [
    version,
    fields[1],
    fields[2],
    processFingerprint,
    fakeFingerprint,
    iv.toString('hex'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('hex'),
  ].join(':');
  const journalDir = reference.path.slice(0, reference.path.lastIndexOf('/'));
  const forgedPath = `${journalDir}/${fakeFingerprint}.owner`;
  const { settlement } = await sweepWithProtocol({
    listBody: listResult(journalDir, [journalEntry(forgedPath, forgedContent)]),
    readBody: {
      success: true,
      data: { file: forgedPath, content: forgedContent },
    },
  });
  assert.equal(settlement.kind, 'indeterminate');
  assert.equal(settlement.cause, 'journal-invalid');
});

await test('journal timeout is bounded and fails closed without DELETE', async () => {
  const calls = [];
  const settlement = await mod.sweepAioStaleTerminalSessions({
    fetch: async (input, init) => {
      calls.push({ input, init });
      return new Promise(() => {});
    },
    baseUrl: 'http://aio.test',
    scope: scope(),
    processFingerprint: 'a'.repeat(64),
    timing: { requestTimeoutMs: 5 },
  });
  assert.equal(settlement.kind, 'indeterminate');
  assert.equal(settlement.cause, 'journal-unconfirmed');
  assert.equal(settlement.inspectedRecords, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'POST');
});

await test('request deadlines fence late provider resolution and invalid timing inputs remain bounded', async () => {
  const ownershipScope = scope();
  for (const [index, requestTimeoutMs] of [
    Number.NaN,
    0,
    10_000,
  ].entries()) {
    const record = ownershipRecord({
      providerSessionId: canonicalProviderSessionId(700 + index),
      ownershipScope,
      processFingerprint: 'a'.repeat(64),
    });
    const journalDir = record.path.slice(0, record.path.lastIndexOf('/'));
    const { settlement } = await sweepWithProtocol({
      ownershipScope,
      timing: { requestTimeoutMs },
      listBody: listResult(journalDir, []),
    });
    assert.equal(settlement.kind, 'confirmed');
  }

  let providerResolved = false;
  const late = await sweepWithProtocol({
    timing: { requestTimeoutMs: 1 },
    listPromise: () =>
      new Promise((resolve) => {
        setTimeout(() => {
          providerResolved = true;
          resolve(response(200, { success: true, data: null }));
        }, 10);
      }),
  });
  assert.equal(late.settlement.cause, 'journal-unconfirmed');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(providerResolved, true);
});

await test('partial exact cleanup remains indeterminate and retains every stale journal record', async () => {
  const ownershipScope = scope();
  const oldProcess = 'b'.repeat(64);
  const deletedId = canonicalProviderSessionId(131);
  const failedId = canonicalProviderSessionId(132);
  const deletedRecord = ownershipRecord({
    providerSessionId: deletedId,
    ownershipScope,
    processFingerprint: oldProcess,
    ivByte: 5,
  });
  const failedRecord = ownershipRecord({
    providerSessionId: failedId,
    ownershipScope,
    processFingerprint: oldProcess,
    role: 'injector',
    ivByte: 6,
  });
  const harness = createJournalFetch({
    records: new Map([
      [deletedRecord.path, deletedRecord.content],
      [failedRecord.path, failedRecord.content],
    ]),
    deleteModes: new Map([[failedId, 'fail']]),
  });
  const settlement = await mod.sweepAioStaleTerminalSessions({
    fetch: harness.fetch,
    baseUrl: 'http://aio.test',
    scope: ownershipScope,
    processFingerprint: 'a'.repeat(64),
    timing: { cleanupRetryDelayMs: 0, cleanupAttemptTimeoutMs: 20 },
    guestPairReleaser: confirmedGuestPairReleaser,
  });
  assert.equal(settlement.kind, 'indeterminate');
  assert.equal(settlement.cause, 'cleanup-unconfirmed');
  assert.equal(settlement.staleRecords, 2);
  assert.equal(settlement.confirmedIdentities, 2);
  assert.equal(settlement.deletedIdentities, 2);
  assert.equal(settlement.removedRecords, 0);
  assert.equal(
    harness.calls.filter(
      (call) =>
        call.method === 'DELETE' &&
        decodeURIComponent(call.path.slice('/v1/shell/sessions/'.length)) ===
          failedId,
    ).length,
    3,
  );
  assert.equal(harness.calls.some((call) => call.path === '/v1/shell/exec'), false);
});

await test('journal-file deletion validates exact paths, bounds, base URLs, and command settlement', async () => {
  let called = false;
  await mod.deleteAioTerminalOwnershipRecordFilesExact({
    fetch: async () => {
      called = true;
      throw new Error('must not run');
    },
    baseUrl: 'http://aio.test',
    paths: [],
  });
  assert.equal(called, false);

  const reference = ownershipRecord({
    providerSessionId: canonicalProviderSessionId(133),
    processFingerprint: 'a'.repeat(64),
  });
  const journalDir = reference.path.slice(0, reference.path.lastIndexOf('/'));
  const tooMany = Array.from(
    { length: 129 },
    (_, index) =>
      `${journalDir}/${createHash('sha256').update(String(index)).digest('hex')}.owner`,
  );
  await assert.rejects(() =>
    mod.deleteAioTerminalOwnershipRecordFilesExact({
      fetch: async () => {
        called = true;
        throw new Error('must not run');
      },
      baseUrl: 'http://aio.test',
      paths: tooMany,
    }),
  );
  for (const paths of [['/tmp/not-owned'], [7]]) {
    await assert.rejects(() =>
      mod.deleteAioTerminalOwnershipRecordFilesExact({
        fetch: async () => {
          called = true;
          throw new Error('must not run');
        },
        baseUrl: 'http://aio.test',
        paths,
      }),
    );
  }
  for (const baseUrl of ['', '////', 7]) {
    await assert.rejects(() =>
      mod.deleteAioTerminalOwnershipRecordFilesExact({
        fetch: async () => {
          called = true;
          throw new Error('must not run');
        },
        baseUrl,
        paths: [reference.path],
      }),
    );
  }

  const baseHarness = createJournalFetch({ records: new Map() });
  const failingFetch = async (input, init) => {
    if (new URL(String(input)).pathname === '/v1/shell/exec') {
      return response(503, { success: false, data: null });
    }
    return baseHarness.fetch(input, init);
  };
  await assert.rejects(() =>
    mod.deleteAioTerminalOwnershipRecordFilesExact({
      fetch: failingFetch,
      baseUrl: 'http://aio.test',
      paths: [reference.path, reference.path],
      requestTimeoutMs: -1,
    }),
  );

  await withManualReleaseClock(70_000_000, async (clock) => {
    await assert.rejects(() =>
      mod.deleteAioTerminalOwnershipRecordFilesExact({
        fetch: async () => {
          // The hanging request spends its whole bounded budget on the
          // injected clock; the margin below no longer reads the real clock.
          clock.advance(5);
          return new Promise(() => {});
        },
        baseUrl: 'http://aio.test',
        paths: [reference.path],
        requestTimeoutMs: 5,
      }),
    );
    assert.equal(clock.elapsed() < 250, true);
  });
});

await test('confirmed session deletion with unconfirmed journal rm stays observable and secret-free', async () => {
  const ownershipScope = scope();
  const sessionId = canonicalProviderSessionId(134);
  const stale = ownershipRecord({
    providerSessionId: sessionId,
    ownershipScope,
    processFingerprint: 'b'.repeat(64),
  });
  const baseHarness = createJournalFetch({
    records: new Map([[stale.path, stale.content]]),
  });
  const fetch = async (input, init) => {
    if (new URL(String(input)).pathname === '/v1/shell/sessions/create') {
      throw new Error('journal command unavailable');
    }
    return baseHarness.fetch(input, init);
  };
  const settlement = await mod.sweepAioStaleTerminalSessions({
    fetch,
    baseUrl: 'http://aio.test',
    scope: ownershipScope,
    processFingerprint: 'a'.repeat(64),
    timing: { cleanupRetryDelayMs: 0 },
    guestPairReleaser: confirmedGuestPairReleaser,
  });
  assert.equal(settlement.kind, 'indeterminate');
  assert.equal(settlement.cause, 'journal-cleanup-unconfirmed');
  assert.equal(settlement.confirmedIdentities, 2);
  assert.equal(settlement.removedRecords, 0);
  assert.equal(JSON.stringify(settlement).includes(sessionId), false);
});

await test('missing exact ownership scope never lists or deletes provider state', async () => {
  let called = false;
  const settlement = await mod.sweepAioStaleTerminalSessions({
    fetch: async () => {
      called = true;
      throw new Error('must not be called');
    },
    baseUrl: 'http://aio.test',
  });
  assert.equal(settlement.kind, 'indeterminate');
  assert.equal(settlement.cause, 'ownership-unavailable');
  assert.equal(called, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
