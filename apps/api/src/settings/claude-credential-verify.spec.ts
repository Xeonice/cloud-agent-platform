import assert from 'node:assert/strict';
import test from 'node:test';

import { BadRequestException } from '@nestjs/common';
import type { SessionUser } from '@cap/contracts';

import {
  ClaudeCredentialProbe,
  classifyProbeStatus,
  ANTHROPIC_PROBE_URL,
  type ClaudeCredentialProbeOutcome,
} from './claude-credential-probe';
import { SettingsService } from './settings.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ModelDiscoveryClient } from './model-discovery.client';
import type { GuardrailsService } from '../guardrails/guardrails.service';

/**
 * fix-claude-onboarding-and-token-verify — save-time verification of a newly
 * pasted Claude credential. The incident this guards against: an invalid
 * setup-token reached `state=connected` unexercised and only surfaced minutes
 * later inside a task, as an un-classified hang.
 */

const OPERATOR: SessionUser = {
  id: 'user-1',
  githubId: null,
  login: null,
  name: 'op@example.test',
  avatarUrl: null,
  allowed: true,
  role: 'member',
  mustChangePassword: false,
};

const ENC_KEY = 'a'.repeat(64); // 32-byte hex server key
const ENV = { CODEX_CRED_ENC_KEY: ENC_KEY } as NodeJS.ProcessEnv;
const TOKEN = 'sk-ant-oat01-not-a-real-token';

interface Harness {
  service: SettingsService;
  probeCalls: Array<{ mode: string }>;
  upserts: unknown[];
}

function harness(
  outcome: ClaudeCredentialProbeOutcome,
  existingRow: Record<string, unknown> | null = null,
): Harness {
  const probeCalls: Array<{ mode: string }> = [];
  const upserts: unknown[] = [];
  let row: Record<string, unknown> | null = existingRow;
  const prisma = {
    claudeCredential: {
      findUnique: async () => row,
      upsert: async (args: { create: Record<string, unknown> }) => {
        upserts.push(args);
        row = { ...args.create };
        return row;
      },
    },
  } as unknown as PrismaService;
  const probe = {
    probe: async (mode: string, secret: string) => {
      // SECRET BOUNDARY: the service must hand the probe the plaintext it was
      // given, and nothing else observes it.
      assert.equal(secret, TOKEN);
      probeCalls.push({ mode });
      return outcome;
    },
  } as unknown as ClaudeCredentialProbe;
  const service = new SettingsService(
    prisma,
    {} as unknown as ModelDiscoveryClient,
    { setMaxConcurrentTasks: () => undefined } as unknown as GuardrailsService,
    probe,
  );
  return { service, probeCalls, upserts };
}

test('accepted probe persists as connected with verification=verified (single attempt)', async () => {
  const h = harness('accepted');
  const saved = await h.service.saveClaudeCredential(
    OPERATOR,
    { mode: 'subscription', setupToken: TOKEN },
    ENV,
  );
  assert.equal(h.probeCalls.length, 1);
  assert.deepEqual(h.probeCalls[0], { mode: 'subscription' });
  assert.equal(h.upserts.length, 1);
  assert.equal(saved.state, 'connected');
  assert.equal(saved.verification, 'verified');
});

test('rejected probe refuses the save, persists nothing, and leaks no secret', async () => {
  const existing = {
    userId: 'user-1',
    mode: 'subscription',
    state: 'connected',
    setupTokenCiphertext: 'prior.iv.tag',
    setupTokenLast4: 'PRI0',
    apiKeyCiphertext: null,
    apiKeyLast4: null,
    defaultModel: null,
  };
  const h = harness('rejected', existing);
  await assert.rejects(
    h.service.saveClaudeCredential(
      OPERATOR,
      { mode: 'subscription', setupToken: TOKEN },
      ENV,
    ),
    (error: unknown) => {
      assert.ok(error instanceof BadRequestException);
      const body = error.getResponse() as { error: string; message: string };
      assert.equal(body.error, 'claude_credential_rejected');
      assert.ok(body.message.length > 0);
      assert.ok(!body.message.includes(TOKEN), 'rejection message must not echo the secret');
      return true;
    },
  );
  // Nothing persisted; the prior credential state is untouched.
  assert.equal(h.upserts.length, 0);
  const read = await h.service.readClaudeCredential(OPERATOR);
  assert.equal(read.state, 'connected');
  assert.equal(read.setupTokenSuffix, 'PRI0');
  assert.equal(read.verification, undefined);
});

test('indeterminate probe still saves as connected, marked indeterminate', async () => {
  const h = harness('indeterminate');
  const saved = await h.service.saveClaudeCredential(
    OPERATOR,
    { mode: 'api_key', apiKey: TOKEN },
    ENV,
  );
  assert.equal(h.probeCalls.length, 1);
  assert.deepEqual(h.probeCalls[0], { mode: 'api_key' });
  assert.equal(h.upserts.length, 1);
  assert.equal(saved.state, 'connected');
  assert.equal(saved.verification, 'indeterminate');
});

test('preserved-by-omission re-save skips the probe and carries no marker', async () => {
  const existing = {
    userId: 'user-1',
    mode: 'subscription',
    state: 'connected',
    setupTokenCiphertext: 'prior.iv.tag',
    setupTokenLast4: 'PRI0',
    apiKeyCiphertext: null,
    apiKeyLast4: null,
    defaultModel: null,
  };
  const h = harness('rejected', existing); // outcome irrelevant — must not be called
  const saved = await h.service.saveClaudeCredential(
    OPERATOR,
    { mode: 'subscription', defaultModel: 'claude-sonnet-5' },
    ENV,
  );
  assert.equal(h.probeCalls.length, 0);
  assert.equal(saved.state, 'connected');
  assert.equal(saved.verification, undefined);
});

// ---------------------------------------------------------------------------
// The probe transport itself, with a faked fetch (no network).
// ---------------------------------------------------------------------------

test('probe status classification: 401/403 reject, 5xx indeterminate, rest accepted', () => {
  assert.equal(classifyProbeStatus(401), 'rejected');
  assert.equal(classifyProbeStatus(403), 'rejected');
  assert.equal(classifyProbeStatus(500), 'indeterminate');
  assert.equal(classifyProbeStatus(529), 'indeterminate');
  // 400 is the EXPECTED zero-cost success shape: auth passed, body complained.
  assert.equal(classifyProbeStatus(400), 'accepted');
  assert.equal(classifyProbeStatus(200), 'accepted');
  assert.equal(classifyProbeStatus(429), 'accepted');
});

test('probe sends mode-appropriate auth headers once against the fixed host', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return { status: 400 } as Response;
  }) as typeof fetch;

  const probe = new ClaudeCredentialProbe();
  assert.equal(await probe.probe('subscription', TOKEN, fakeFetch), 'accepted');
  assert.equal(calls.length, 1, 'single attempt, no retry');
  assert.equal(calls[0].url, ANTHROPIC_PROBE_URL);
  const subHeaders = calls[0].init.headers as Record<string, string>;
  assert.equal(subHeaders['authorization'], `Bearer ${TOKEN}`);
  assert.equal(subHeaders['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(subHeaders['x-api-key'], undefined);

  assert.equal(await probe.probe('api_key', TOKEN, fakeFetch), 'accepted');
  const keyHeaders = calls[1].init.headers as Record<string, string>;
  assert.equal(keyHeaders['x-api-key'], TOKEN);
  assert.equal(keyHeaders['authorization'], undefined);
});

test('probe network failure is indeterminate, not a save blocker', async () => {
  const failingFetch = (async () => {
    throw new Error('getaddrinfo ENOTFOUND api.anthropic.com');
  }) as unknown as typeof fetch;
  const probe = new ClaudeCredentialProbe();
  assert.equal(
    await probe.probe('subscription', TOKEN, failingFetch),
    'indeterminate',
  );
});
