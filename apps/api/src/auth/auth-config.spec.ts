import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAutoSameHostWebOrigin,
  isAutoSameHostWebOriginEnabled,
  readAutoSameHostWebOriginPort,
} from './auth-config';

test('same-host web origin auto-allow is opt-in', () => {
  assert.equal(isAutoSameHostWebOriginEnabled({}), false);
  assert.equal(
    isAutoSameHostWebOriginEnabled({ WEB_ORIGIN_AUTO_SAME_HOST: 'true' }),
    true,
  );
});

test('same-host web origin matches the request hostname and configured web port', () => {
  const env = {
    WEB_ORIGIN_AUTO_SAME_HOST: 'true',
    WEB_ORIGIN_AUTO_SAME_HOST_PORT: '3000',
  };

  assert.equal(
    isAutoSameHostWebOrigin(
      'http://100.101.167.99:3000',
      '100.101.167.99:18080',
      env,
    ),
    true,
  );
  assert.equal(
    isAutoSameHostWebOrigin(
      'http://100.101.167.99:5173',
      '100.101.167.99:18080',
      env,
    ),
    false,
  );
  assert.equal(
    isAutoSameHostWebOrigin(
      'http://100.101.167.100:3000',
      '100.101.167.99:18080',
      env,
    ),
    false,
  );
});

test('same-host web origin port falls back to WEB_HOST_PORT then 3000', () => {
  assert.equal(
    readAutoSameHostWebOriginPort({
      WEB_HOST_PORT: '3100',
    }),
    '3100',
  );
  assert.equal(readAutoSameHostWebOriginPort({}), '3000');
});
