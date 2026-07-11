import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  REDACTED,
  decodeZipArchive,
  encodeZipArchive,
  sanitizeArtifacts,
} from './sanitize-scheduled-tasks-e2e-artifacts.mjs';

test('sanitizes ordinary text artifacts without removing diagnostic context', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cap-schedule-sanitize-text-'));
  const log = join(directory, 'api.log');
  const secrets = [
    'Bearer plain-auth-value',
    'session=plain-cookie-value',
    'rotated=plain-set-cookie-value',
    'plain-password-value',
    'plain-current-password',
    'plain-new-password',
    'plain-token-value',
    'plain-secret-value',
    'plain-fill-value',
    'plain-type-value',
    'plain-title-fill-value',
    'plain-title-type-value',
  ];

  try {
    await writeFile(
      log,
      [
        'request failed while logging in',
        `Authorization: ${secrets[0]}`,
        `Cookie: ${secrets[1]}`,
        `Set-Cookie: ${secrets[2]}`,
        `password="${secrets[3]}"`,
        `currentPassword=${secrets[4]}`,
        `newPassword=${secrets[5]}`,
        `token: ${secrets[6]}`,
        `secret=${secrets[7]}`,
        `fill("${secrets[8]}")`,
        `type('${secrets[9]}')`,
        `Fill "${secrets[10]}" getByLabel('Password')`,
        `Type '${secrets[11]}' locator('#token')`,
      ].join('\n'),
    );

    await sanitizeArtifacts(directory);
    const sanitized = await readFile(log, 'utf8');
    assert.match(sanitized, /request failed while logging in/);
    assert.match(sanitized, /\[REDACTED\]/);
    for (const secret of secrets) assert.equal(sanitized.includes(secret), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('recursively sanitizes Playwright trace ZIP entries and leaves a valid archive', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cap-schedule-sanitize-zip-'));
  const tracePath = join(directory, 'trace.zip');
  const binaryResource = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
  const secrets = {
    fill: 'trace-fill-value',
    log: 'trace-log-value',
    snapshot: 'trace-snapshot-value',
    typed: 'trace-type-value',
    pwApiFillTitle: 'trace-pw-api-fill-title-value',
    pwApiFillParam: 'trace-pw-api-fill-param-value',
    pwApiTypeTitle: 'trace-pw-api-type-title-value',
    pwApiTypeParam: 'trace-pw-api-type-param-value',
    expectedValue: 'trace-expected-password-value',
    receivedValue: 'trace-received-password-value',
    authorization: 'Bearer trace-authorization-value',
    cookie: 'session=trace-cookie-value',
    setCookie: 'session=trace-set-cookie-value',
    postData: 'trace-post-data-value',
    password: 'trace-password-value',
    currentPassword: 'trace-current-password-value',
    newPassword: 'trace-new-password-value',
    token: 'trace-token-value',
    secret: 'trace-secret-value',
    cookieArray: 'trace-cookie-array-value',
  };
  const traceLines = [
    {
      type: 'before',
      method: 'fill',
      params: { selector: 'input[type=password]', value: secrets.fill },
    },
    { type: 'log', message: `  fill("${secrets.log}")` },
    {
      type: 'frame-snapshot',
      snapshot: {
        html: ['INPUT', { type: 'password', __playwright_value_: secrets.snapshot }],
      },
    },
    {
      type: 'before',
      method: 'type',
      params: { selector: '#token', text: secrets.typed },
    },
    {
      type: 'before',
      method: 'pw:api',
      title: `Fill "${secrets.pwApiFillTitle}" getByLabel('Password')`,
      params: { selector: 'internal:label="Password"i', value: secrets.pwApiFillParam },
    },
    {
      type: 'before',
      method: 'pw:api',
      title: `Type "${secrets.pwApiTypeTitle}" locator('#token')`,
      params: { selector: '#token', text: secrets.pwApiTypeParam },
    },
    {
      type: 'before',
      callId: 'expect@password',
      method: 'expect',
      title: 'Expect "toHaveValue"',
      params: {
        selector: 'internal:label="Password"i',
        expectedText: [{ string: secrets.expectedValue }],
      },
    },
    {
      type: 'after',
      callId: 'expect@password',
      result: {
        matches: true,
        received: {
          value: { s: secrets.receivedValue },
          ariaSnapshot: `- textbox "Password": ${secrets.receivedValue}`,
        },
      },
    },
  ];
  const networkLine = {
    type: 'resource-snapshot',
    snapshot: {
      request: {
        headers: [
          { name: 'Authorization', value: secrets.authorization },
          { name: 'Cookie', value: secrets.cookie },
          { name: 'Accept', value: 'application/json' },
        ],
        postData: JSON.stringify({
          password: secrets.password,
          currentPassword: secrets.currentPassword,
          newPassword: secrets.newPassword,
          token: secrets.token,
          secret: secrets.secret,
          retained: 'diagnostic-value',
        }),
      },
      response: {
        headers: [{ name: 'Set-Cookie', value: secrets.setCookie }],
      },
      cookies: [
        { name: 'session', value: secrets.cookieArray, domain: '127.0.0.1' },
        { name: 'secondary', value: secrets.cookie, domain: '127.0.0.1' },
      ],
    },
  };

  try {
    await writeFile(
      tracePath,
      encodeZipArchive([
        {
          name: 'trace.trace',
          method: 8,
          data: Buffer.from(traceLines.map((line) => JSON.stringify(line)).join('\n')),
        },
        {
          name: 'trace.network',
          method: 8,
          data: Buffer.from(`${JSON.stringify(networkLine)}\n`),
        },
        { name: 'resources/image', method: 0, data: binaryResource },
      ]),
    );

    await sanitizeArtifacts(directory);

    const archive = await readFile(tracePath);
    const unzip = spawnSync('unzip', ['-t', tracePath], { encoding: 'utf8' });
    assert.equal(unzip.status, 0, unzip.stderr || unzip.stdout);

    const entries = decodeZipArchive(archive);
    assert.equal(entries.length, 3);
    assert.deepEqual(
      entries.find((entry) => entry.name === 'resources/image')?.data,
      binaryResource,
    );

    const traceText = entries
      .find((entry) => entry.name === 'trace.trace')
      ?.data.toString('utf8');
    const networkText = entries
      .find((entry) => entry.name === 'trace.network')
      ?.data.toString('utf8');
    assert.ok(traceText);
    assert.ok(networkText);
    const combined = `${traceText}\n${networkText}`;
    for (const secret of Object.values(secrets)) {
      assert.equal(combined.includes(secret), false, `trace retained ${secret}`);
    }
    assert.match(combined, /\[REDACTED\]/);

    const sanitizedNetwork = JSON.parse(networkText.trim());
    assert.equal(sanitizedNetwork.snapshot.request.postData, REDACTED);
    assert.equal(sanitizedNetwork.snapshot.request.headers[0].value, REDACTED);
    assert.equal(sanitizedNetwork.snapshot.request.headers[1].value, REDACTED);
    assert.equal(
      sanitizedNetwork.snapshot.request.headers[2].value,
      'application/json',
    );
    assert.equal(sanitizedNetwork.snapshot.response.headers[0].value, REDACTED);
    assert.equal(
      sanitizedNetwork.snapshot.cookies.every((cookie) => cookie.value === REDACTED),
      true,
    );
    assert.equal(sanitizedNetwork.snapshot.cookies[0].name, 'session');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
