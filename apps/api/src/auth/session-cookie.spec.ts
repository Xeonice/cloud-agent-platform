import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';
import { buildSessionCookies, isCrossOrigin } from './session-cookie';

function req(host: string, protocol = 'http', origin?: string): Request {
  return {
    headers: { host, ...(origin ? { origin } : {}) },
    protocol,
  } as unknown as Request;
}

function withEnv(
  patch: NodeJS.ProcessEnv,
  fn: () => void,
): void {
  const previous: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(patch)) {
    process.env[key] = patch[key];
  }
  try {
    fn();
  } finally {
    process.env = previous;
  }
}

test('same hostname with different web/api ports does not require cross-site cookie mode', () => {
  assert.equal(
    isCrossOrigin(
      req('100.101.167.99:18080'),
      'http://100.101.167.99:3000',
    ),
    false,
  );
});

test('different hostname still requires cross-site cookie mode', () => {
  assert.equal(
    isCrossOrigin(
      req('cap-api.example.com'),
      'https://cap.example.com',
    ),
    true,
  );
});

test('same-host http login cookie stays Lax and non-Secure', () => {
  withEnv(
    {
      WEB_ORIGIN: 'http://100.101.167.99:3000',
      SESSION_COOKIE_DOMAIN: '',
    },
    () => {
      const [cookie] = buildSessionCookies(
        req('100.101.167.99:18080', 'http'),
        'TOKEN',
      );

      assert.ok(cookie.includes('SameSite=Lax'));
      assert.equal(cookie.includes('SameSite=None'), false);
      assert.equal(cookie.includes('Secure'), false);
    },
  );
});

test('auto same-host origin keeps LAN http login cookie Lax and non-Secure', () => {
  withEnv(
    {
      WEB_ORIGIN: 'http://localhost:3000',
      WEB_ORIGIN_AUTO_SAME_HOST: 'true',
      WEB_ORIGIN_AUTO_SAME_HOST_PORT: '3000',
      SESSION_COOKIE_DOMAIN: '',
    },
    () => {
      const [cookie] = buildSessionCookies(
        req(
          '100.101.167.99:18080',
          'http',
          'http://100.101.167.99:3000',
        ),
        'TOKEN',
      );

      assert.ok(cookie.includes('SameSite=Lax'));
      assert.equal(cookie.includes('SameSite=None'), false);
      assert.equal(cookie.includes('Secure'), false);
    },
  );
});

test('cross-host login cookie uses SameSite=None and Secure', () => {
  withEnv(
    {
      WEB_ORIGIN: 'https://web.other.example',
      SESSION_COOKIE_DOMAIN: '',
    },
    () => {
      const [cookie] = buildSessionCookies(
        req('cap-api.example.com', 'https'),
        'TOKEN',
      );

      assert.ok(cookie.includes('SameSite=None'));
      assert.ok(cookie.includes('Secure'));
    },
  );
});
