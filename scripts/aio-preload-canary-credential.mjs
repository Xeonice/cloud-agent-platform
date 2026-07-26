#!/usr/bin/env node

/**
 * Deprecated one-way credential preload for an explicitly disposable remote
 * AIO canary. Release verification must use the real CLI canary's atomic
 * `--auth stdin` path instead; this command requires an explicit unsafe
 * handoff acknowledgement because no second process can inherit its cleanup
 * ownership atomically.
 *
 * Credential bytes arrive only on stdin, cross the SSH-tunnelled AIO file API
 * as a base64 request body, and are never placed in argv, shell command text,
 * stdout, or stderr. Every short verification exec is deleted by its exact AIO
 * session id before this process reports success.
 */

import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_STDIN_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const OWNERSHIP_ACK = 'isolated-disposable';
const UNSAFE_HANDOFF_ACK = 'acknowledged';
let activeStage = 'arguments';
let activeCliLease = null;
let activeCliOperation = null;
let cliStopRequested = false;
let activeStdinAbortController = null;
let cliSignalPromise = null;
let cliSignalCleanupFailed = false;
let cliRequestedSignal = null;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  activeStage = 'stdin';
  const stdinAbortController = new AbortController();
  activeStdinAbortController = stdinAbortController;
  let input;
  try {
    input = await readAioCanaryCredentialStdin({
      signal: stdinAbortController.signal,
    });
  } finally {
    if (activeStdinAbortController === stdinAbortController) {
      activeStdinAbortController = null;
    }
  }
  let lease = null;
  let unsafeHandoffReady = false;
  let primaryError = null;
  try {
    lease = createAioCanaryCredentialLease({
      endpoint: options.endpoint,
      runtime: options.runtime,
      envelopeBytes: input,
    });
    activeCliLease = lease;
    activeStage = 'preload';
    activeCliOperation = lease.preload();
    const evidence = await activeCliOperation;
    if (cliStopRequested) throw new Error('credential preload was stopped');
    lease.allowUnsafeHandoff();
    activeStage = 'complete';
    await writeCliStdout(
      `${JSON.stringify({
        result: 'UNSAFE_HANDOFF_READY',
        releaseGateEligible: false,
        deprecated: true,
        runtime: options.runtime,
        bytes: evidence.bytes,
        privateFileMode: '0600',
        exactExecSessionsCleaned: true,
      })}\n`,
    );
    if (cliStopRequested) throw new Error('credential preload was stopped');
    unsafeHandoffReady = true;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    input.fill(0);
    activeCliOperation = null;
    if (lease && (!unsafeHandoffReady || cliStopRequested)) {
      activeStage = 'failure-cleanup';
      try {
        await lease.cleanup();
      } catch (cleanupError) {
        throw new AggregateError(
          primaryError ? [primaryError, cleanupError] : [cleanupError],
          'AIO canary credential preload cleanup failed',
        );
      }
    }
    if (activeCliLease === lease) activeCliLease = null;
  }
}

export function parseAioPreloadCredentialArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !value || values.has(key)) throw new Error('invalid arguments');
    values.set(key, value);
  }
  for (const key of values.keys()) {
    if (
      key !== '--endpoint' &&
      key !== '--runtime' &&
      key !== '--aio-state-ownership' &&
      key !== '--unsafe-preloaded-credential-handoff'
    ) {
      throw new Error('invalid arguments');
    }
  }
  const endpoint = normalizeEndpoint(values.get('--endpoint'));
  const runtime = values.get('--runtime');
  if (runtime !== 'codex' && runtime !== 'claude-code') {
    throw new Error('invalid runtime');
  }
  if (values.get('--aio-state-ownership') !== OWNERSHIP_ACK) {
    throw new Error('disposable AIO ownership acknowledgement is required');
  }
  if (
    values.get('--unsafe-preloaded-credential-handoff') !==
    UNSAFE_HANDOFF_ACK
  ) {
    throw new Error(
      'unsafe preloaded credential handoff acknowledgement is required',
    );
  }
  return { endpoint, runtime, unsafePreloadedCredentialHandoff: true };
}

const parseArgs = parseAioPreloadCredentialArgs;

function normalizeEndpoint(value) {
  if (typeof value !== 'string') throw new Error('invalid endpoint');
  const url = new URL(value);
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('invalid endpoint');
  }
  return url.href.replace(/\/+$/u, '');
}

export function readAioCanaryCredentialStdin({
  stream = process.stdin,
  signal,
  maxBytes = MAX_STDIN_BYTES,
  timeoutMs = 30_000,
} = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const clearChunks = () => {
      for (const retained of chunks) retained.fill(0);
    };
    const onData = (value) => {
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        chunk.fill(0);
        clearChunks();
        settle(() => reject(new Error('stdin exceeded limit')));
        if (typeof stream.pause === 'function') stream.pause();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () =>
      settle(() => {
        const result = Buffer.concat(chunks, total);
        clearChunks();
        resolve(result);
      });
    const onError = () =>
      settle(() => {
        clearChunks();
        reject(new Error('stdin failed'));
      });
    const onAbort = () =>
      settle(() => {
        clearChunks();
        reject(new Error('stdin was stopped'));
      });
    const timer = setTimeout(
      () =>
        settle(() => {
          clearChunks();
          reject(new Error('stdin timed out'));
        }),
      timeoutMs,
    );
    const settle = (continuation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
      continuation();
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (typeof stream.resume === 'function') stream.resume();
  });
}

export function parseAioCanaryCredentialEnvelope(payload, runtime) {
  if (runtime !== 'codex' && runtime !== 'claude-code') {
    throw new Error('invalid runtime');
  }
  let parsed;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
    parsed = JSON.parse(text);
  } catch {
    throw new Error('invalid credential envelope');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid credential envelope');
  }
  if (runtime === 'codex') {
    if (typeof parsed.codexAuthJson !== 'string') {
      throw new Error('Codex credential missing');
    }
    let auth;
    try {
      auth = JSON.parse(parsed.codexAuthJson);
    } catch {
      throw new Error('Codex credential invalid');
    }
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
      throw new Error('Codex credential invalid');
    }
    return { codexAuthJson: parsed.codexAuthJson };
  }
  if (
    typeof parsed.claudeOauthToken !== 'string' ||
    parsed.claudeOauthToken.length < 8 ||
    /[\u0000-\u001f\u007f]/u.test(parsed.claudeOauthToken)
  ) {
    throw new Error('Claude credential invalid');
  }
  return { claudeOauthToken: parsed.claudeOauthToken };
}

const parseEnvelope = parseAioCanaryCredentialEnvelope;

function buildCredentialFile(envelope, runtime) {
  if (runtime === 'codex') {
    const path = '/home/gem/.codex/auth.json';
    return {
      credentialBytes: Buffer.from(envelope.codexAuthJson, 'utf8'),
      target: {
        path,
        prepareCommand:
          'GEM_GROUP=$(id -gn gem) && install -d -m 700 -o gem -g "$GEM_GROUP" /home/gem/.codex',
        verifyCommand:
          `chown gem:"$(id -gn gem)" ${shellQuote(path)} && ` +
          `chmod 600 ${shellQuote(path)} && ` +
          `test "$(stat -c %a ${shellQuote(path)})" = 600 && ` +
          `sha256sum ${shellQuote(path)} | cut -d' ' -f1`,
        cleanupCommand: `rm -f -- ${shellQuote(path)} && test ! -e ${shellQuote(path)}`,
      },
    };
  }
  const path = '/home/gem/.claude/launch-env.sh';
  const content = `export CLAUDE_CODE_OAUTH_TOKEN=${shellQuote(
    envelope.claudeOauthToken,
  )}\n`;
  return {
    credentialBytes: Buffer.from(content, 'utf8'),
    target: {
      path,
      prepareCommand:
        'GEM_GROUP=$(id -gn gem) && install -d -m 700 -o gem -g "$GEM_GROUP" /home/gem/.claude',
      verifyCommand:
        `chown gem:"$(id -gn gem)" ${shellQuote(path)} && ` +
        `chmod 600 ${shellQuote(path)} && ` +
        `test "$(stat -c %a ${shellQuote(path)})" = 600 && ` +
        `sha256sum ${shellQuote(path)} | cut -d' ' -f1`,
      cleanupCommand: `rm -f -- ${shellQuote(path)} && test ! -e ${shellQuote(path)}`,
    },
  };
}

/**
 * Owns one bounded AIO canary credential from preload through exact removal.
 * The caller must keep this lease in the same try/finally as the real CLI run.
 * Ordinary work can be stopped, but cleanup deliberately uses the supplied raw
 * executor after it has waited for the in-flight preload/session to settle.
 */
export function createAioCanaryCredentialLease({
  endpoint,
  runtime,
  envelopeBytes,
  executeCommand = ({ endpoint: targetEndpoint, command, label }) =>
    execAioCommand(targetEndpoint, command, label),
  writeFile = writeAioFile,
}) {
  const normalizedEndpoint = normalizeEndpoint(endpoint);
  if (runtime !== 'codex' && runtime !== 'claude-code') {
    throw new Error('invalid runtime');
  }
  if (!Buffer.isBuffer(envelopeBytes) && !(envelopeBytes instanceof Uint8Array)) {
    throw new Error('invalid credential envelope');
  }
  if (typeof executeCommand !== 'function' || typeof writeFile !== 'function') {
    throw new Error('invalid credential lease adapter');
  }

  let envelope = parseEnvelope(envelopeBytes, runtime);
  const { credentialBytes, target } = buildCredentialFile(envelope, runtime);
  envelope = undefined;
  const byteLength = credentialBytes.byteLength;
  const expectedDigest = sha256(credentialBytes);
  let stopRequested = false;
  let preloadPromise = null;
  let cleanupPromise = null;
  let preloaded = false;
  let unsafeHandoffAllowed = false;

  const ensureCanContinue = () => {
    if (stopRequested) throw new Error('credential preload was stopped');
    if (cleanupPromise) throw new Error('credential cleanup already started');
  };

  const invoke = async (command, label) => {
    try {
      return await executeCommand({
        endpoint: normalizedEndpoint,
        command,
        label,
      });
    } catch {
      throw new Error(`${label} failed`);
    }
  };

  const preload = () => {
    if (preloadPromise) return preloadPromise;
    preloadPromise = (async () => {
      try {
        ensureCanContinue();
        await invoke(target.prepareCommand, 'credential directory preparation');
        ensureCanContinue();
        try {
          await writeFile({
            endpoint: normalizedEndpoint,
            path: target.path,
            content: credentialBytes,
          });
        } catch {
          throw new Error('private credential file write failed');
        }
        ensureCanContinue();
        const digestOutput = await invoke(
          target.verifyCommand,
          'private credential verification',
        );
        ensureCanContinue();
        if (String(digestOutput).trim() !== expectedDigest) {
          throw new Error('private credential verification failed');
        }
        preloaded = true;
        return { bytes: byteLength };
      } finally {
        credentialBytes.fill(0);
      }
    })();
    return preloadPromise;
  };

  const requestStop = () => {
    stopRequested = true;
  };

  const cleanup = () => {
    requestStop();
    if (cleanupPromise) return cleanupPromise;
    const attempt = (async () => {
      if (preloadPromise) await preloadPromise.catch(() => undefined);
      try {
        await executeCommand({
          endpoint: normalizedEndpoint,
          command: target.cleanupCommand,
          label: 'exact credential cleanup',
        });
      } catch {
        throw new Error('exact credential cleanup failed');
      }
      preloaded = false;
      unsafeHandoffAllowed = false;
    })();
    cleanupPromise = attempt.catch((error) => {
      cleanupPromise = null;
      throw error;
    });
    return cleanupPromise;
  };

  const allowUnsafeHandoff = () => {
    if (!preloaded || stopRequested || cleanupPromise) {
      throw new Error('unsafe credential handoff is not ready');
    }
    unsafeHandoffAllowed = true;
  };

  return Object.freeze({
    preload,
    cleanup,
    requestStop,
    allowUnsafeHandoff,
    get credentialPath() {
      return target.path;
    },
    get unsafeHandoffAllowed() {
      return unsafeHandoffAllowed;
    },
  });
}

async function writeAioFile({ endpoint, path, content }) {
  const response = await fetchWithTimeout(`${endpoint}/v1/file/write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      file: path,
      content: content.toString('base64'),
      encoding: 'base64',
      append: false,
      leading_newline: false,
      trailing_newline: false,
      sudo: false,
    }),
  });
  const body = await response.json().catch(() => undefined);
  if (
    !response.ok ||
    !body ||
    body.success !== true ||
    body.data?.file !== path ||
    body.data?.bytes_written !== content.byteLength
  ) {
    throw new Error('private file write was not confirmed');
  }
}

async function execAioCommand(endpoint, command, label) {
  const operationStage = activeStage;
  const sessionId = randomUUID();
  let operationFailed = false;
  let failureStage = null;
  try {
    activeStage = `${operationStage}-session-create`;
    const createResponse = await fetchWithTimeout(
      `${endpoint}/v1/shell/sessions/create`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: sessionId }),
      },
    );
    const createBody = await createResponse.json().catch(() => undefined);
    if (
      !createResponse.ok ||
      createBody?.success !== true ||
      createBody?.data?.session_id !== sessionId ||
      typeof createBody?.data?.working_dir !== 'string'
    ) {
      activeStage = `${operationStage}-session-create-http-${createResponse.status}`;
      throw new Error(`${label} session creation was not confirmed`);
    }
    activeStage = `${operationStage}-exec`;
    const response = await fetchWithTimeout(`${endpoint}/v1/shell/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: sessionId, command, async_mode: false }),
    });
    const body = await response.json().catch(() => undefined);
    if (
      !response.ok ||
      body?.success !== true ||
      body?.data?.session_id !== sessionId ||
      body?.data?.command !== command ||
      body?.data?.status !== 'completed' ||
      body?.data?.exit_code !== 0 ||
      typeof body?.data?.output !== 'string'
    ) {
      const exitClass = Number.isInteger(body?.data?.exit_code)
        ? String(body.data.exit_code)
        : 'unknown';
      activeStage = `${operationStage}-exec-http-${response.status}-exit-${exitClass}`;
      throw new Error(`${label} was not confirmed`);
    }
    return body.data.output;
  } catch (error) {
    operationFailed = true;
    if (process.env.CAP_AIO_PRELOAD_DEBUG === '1') {
      const stack =
        error && typeof error === 'object' && typeof error.stack === 'string'
          ? error.stack
              .split('\n')
              .slice(0, 4)
              .join('\n')
              .replaceAll(endpoint, '[endpoint]')
          : 'unknown error';
      process.stderr.write(`${stack}\n`);
    }
    const errorClass =
      error && typeof error === 'object' && typeof error.name === 'string'
        ? error.name.replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 32)
        : 'unknown';
    const causeCode =
      error &&
      typeof error === 'object' &&
      error.cause &&
      typeof error.cause === 'object' &&
      typeof error.cause.code === 'string'
        ? error.cause.code.replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 32)
        : 'none';
    failureStage = `${activeStage}-${errorClass || 'unknown'}-${causeCode || 'none'}`;
    throw error;
  } finally {
    activeStage = `${operationStage}-session-cleanup`;
    await deleteAioSessionExact(endpoint, sessionId);
    activeStage = operationFailed ? failureStage : operationStage;
  }
}

async function deleteAioSessionExact(endpoint, sessionId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetchWithTimeout(
      `${endpoint}/v1/shell/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    );
    const body = await response.json().catch(() => undefined);
    if (
      response.ok &&
      body?.data?.session_id === sessionId &&
      (body?.success === true ||
        (body?.success === false &&
          body?.message === `Session ${sessionId} not found`))
    ) {
      return;
    }
  }
  throw new Error('AIO exec session cleanup was not confirmed');
}

function fetchWithTimeout(url, init) {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function writeCliStdout(value) {
  return new Promise((resolveWrite, rejectWrite) => {
    process.stdout.write(value, (error) => {
      if (error) rejectWrite(new Error('stdout write failed'));
      else resolveWrite();
    });
  });
}

function requestCliSignal(signalName) {
  if (cliSignalPromise) return;
  cliRequestedSignal = signalName;
  cliStopRequested = true;
  activeStage = `signal-${signalName.toLowerCase()}`;
  activeStdinAbortController?.abort();
  const lease = activeCliLease;
  const operation = activeCliOperation;
  lease?.requestStop();
  cliSignalPromise = (async () => {
    try {
      if (operation) await operation.catch(() => undefined);
      if (lease) await lease.cleanup();
    } catch {
      cliSignalCleanupFailed = true;
    }
    process.exitCode = cliSignalCleanupFailed
      ? 1
      : signalName === 'SIGINT'
        ? 130
        : 143;
  })();
}

async function runCli() {
  const onSigint = () => requestCliSignal('SIGINT');
  const onSigterm = () => requestCliSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    await main();
  } catch {
    if (cliSignalPromise) await cliSignalPromise;
    if (!cliRequestedSignal || cliSignalCleanupFailed) {
      process.stderr.write(
        `Error: AIO canary credential preload did not settle safely (stage=${activeStage})\n`,
      );
      process.exitCode = 1;
    }
  } finally {
    if (cliSignalPromise) await cliSignalPromise;
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await runCli();
}
