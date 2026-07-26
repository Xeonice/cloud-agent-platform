#!/usr/bin/env node

/**
 * Emits one runtime's credential envelope to stdout for a direct SSH pipe.
 * Never invoke this helper without piping stdout to the canary process.
 */

import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_CODEX_AUTH_JSON_BYTES = 1024 * 1024;
const MAX_CLAUDE_CREDENTIAL_BYTES = 64 * 1024;

function main() {
  const runtime = parseArgs(process.argv.slice(2));
  const envelope =
    runtime === 'codex'
      ? { codexAuthJson: loadCodexAuthJson() }
      : { claudeOauthToken: loadClaudeOauthToken() };
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function parseArgs(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(
      'Usage: emit-yolo-canary-credentials.mjs --runtime codex|claude-code\n',
    );
    process.exit(0);
  }
  if (
    argv.length !== 2 ||
    argv[0] !== '--runtime' ||
    !['codex', 'claude-code'].includes(argv[1])
  ) {
    throw new Error('invalid credential emitter arguments');
  }
  return argv[1];
}

function loadCodexAuthJson() {
  const path = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
  const payload = readBoundedRegularFile(path, MAX_CODEX_AUTH_JSON_BYTES);
  try {
    const authJson = decodeUtf8(payload, 'Codex auth file');
    let parsed;
    try {
      parsed = JSON.parse(authJson);
    } catch {
      throw new Error('Codex auth file is not valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Codex auth file is not a JSON object');
    }
    return authJson;
  } finally {
    payload.fill(0);
  }
}

function loadClaudeOauthToken() {
  const result = spawnSync(
    '/usr/bin/security',
    ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
    {
      encoding: null,
      maxBuffer: MAX_CLAUDE_CREDENTIAL_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    },
  );
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0);
  try {
    if (result.error || result.signal || result.status !== 0 || stdout.length === 0) {
      throw new Error('Claude Code credential is unavailable');
    }
    if (stdout.byteLength > MAX_CLAUDE_CREDENTIAL_BYTES) {
      throw new Error('Claude Code credential exceeds 64 KiB');
    }
    const raw = decodeUtf8(stdout, 'Claude Code credential').trim();
    let token = raw;
    if (raw.startsWith('{')) {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error('Claude Code credential is not valid JSON');
      }
      token =
        parsed?.claudeAiOauth?.accessToken ??
        parsed?.oauthToken ??
        parsed?.accessToken;
    }
    if (
      typeof token !== 'string' ||
      token.length < 8 ||
      Buffer.byteLength(token, 'utf8') > MAX_CLAUDE_CREDENTIAL_BYTES ||
      /[\u0000-\u001f\u007f]/u.test(token)
    ) {
      throw new Error('Claude Code credential has an invalid token');
    }
    return token;
  } finally {
    stdout.fill(0);
    stderr.fill(0);
  }
}

function readBoundedRegularFile(path, maxBytes) {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(path, flags);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size <= 0 || before.size > maxBytes) {
      throw new Error('credential file is not a bounded regular file');
    }
    const payload = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < payload.byteLength) {
      const bytesRead = readSync(
        fd,
        payload,
        offset,
        payload.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = fstatSync(fd);
    if (
      offset !== payload.byteLength ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size
    ) {
      payload.fill(0);
      throw new Error('credential file changed while it was read');
    }
    return payload;
  } finally {
    closeSync(fd);
  }
}

function decodeUtf8(payload, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

process.stdout.on('error', (error) => {
  if (error?.code === 'EPIPE') process.exit(1);
  process.stderr.write('Error: credential envelope could not be written\n');
  process.exitCode = 1;
});

try {
  main();
} catch {
  process.stderr.write('Error: unable to emit canary credentials\n');
  process.exitCode = 1;
}
