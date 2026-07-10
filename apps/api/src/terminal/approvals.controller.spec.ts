import test from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';

import {
  ApprovalsController,
  validateSandboxCallbackSource,
} from './approvals.controller';

const PRIVATE_PEERS = [
  '127.0.0.1',
  '127.99.1.2',
  '10.0.0.2',
  '172.16.0.2',
  '172.31.255.254',
  '192.168.50.2',
  '169.254.1.2',
  '::1',
  '::ffff:172.18.0.4',
  'fc00::2',
  'fd12:3456::2',
  'fe80::2%eth0',
] as const;

const PUBLIC_OR_INVALID_PEERS = [
  undefined,
  '',
  '0.0.0.0',
  '8.8.8.8',
  '100.64.0.1',
  '172.15.255.255',
  '172.32.0.1',
  '192.0.2.1',
  '::',
  '2001:4860:4860::8888',
  'not-an-ip',
] as const;

test('sandbox callback source allows direct loopback, private, link-local, and ULA peers', () => {
  for (const remoteAddress of PRIVATE_PEERS) {
    assert.deepEqual(
      validateSandboxCallbackSource({ remoteAddress, headers: {} }),
      { allowed: true },
      remoteAddress,
    );
  }
});

test('sandbox callback source rejects public, unspecified, missing, and malformed peers', () => {
  for (const remoteAddress of PUBLIC_OR_INVALID_PEERS) {
    assert.equal(
      validateSandboxCallbackSource({ remoteAddress, headers: {} }).allowed,
      false,
      String(remoteAddress),
    );
  }
});

test('sandbox callback source rejects forwarding headers before trusting a private peer', () => {
  for (const header of ['Forwarded', 'X-Forwarded-For', 'x-real-ip']) {
    assert.deepEqual(
      validateSandboxCallbackSource({
        remoteAddress: '172.18.0.4',
        headers: { [header]: '' },
      }),
      { allowed: false, reason: 'forwarded-header' },
      header,
    );
  }
});

test('controller rejects an untrusted source before calling the gateway', async () => {
  let gatewayCalls = 0;
  const controller = new ApprovalsController({
    requestApproval: async () => {
      gatewayCalls += 1;
      return { decision: { behavior: 'allow' } };
    },
    reportPostToolUse: () => {
      gatewayCalls += 1;
    },
  } as never);

  await assert.rejects(
    () =>
      controller.handle(
        {
          channel: 'control',
          type: 'post_tool_use_report',
          taskId: '11111111-1111-4111-8111-111111111111',
          edits: [],
        },
        requestFrom('203.0.113.10'),
      ),
    ForbiddenException,
  );
  assert.equal(gatewayCalls, 0);
});

test('controller accepts a direct cap-net peer and forwards a valid report', async () => {
  let reports = 0;
  const controller = new ApprovalsController({
    reportPostToolUse: () => {
      reports += 1;
    },
  } as never);

  await controller.handle(
    {
      channel: 'control',
      type: 'post_tool_use_report',
      taskId: '11111111-1111-4111-8111-111111111111',
      edits: [],
    },
    requestFrom('172.18.0.4'),
  );
  assert.equal(reports, 1);
});

function requestFrom(
  remoteAddress: string,
  headers: Record<string, string> = {},
): Request {
  return {
    headers,
    socket: { remoteAddress },
  } as unknown as Request;
}
