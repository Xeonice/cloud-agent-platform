/**
 * The console ↔ api build-identity comparison.
 *
 * Three call sites share this function — the REST guard, the WebSocket connect
 * path, and this test — specifically so they cannot disagree about what a
 * mismatch is. These cases pin the two verdicts that REFUSE and, just as
 * importantly, the two that do not: a gate that fires when it cannot tell is a
 * gate that gets switched off, and a gate that breaks `pnpm dev` is worse than
 * the drift it was built for.
 *
 * Run: node --test src/console-build-identity.test.mjs
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  compareConsoleBuild,
  describeConsoleBuildRefusal,
  CONSOLE_BUILD_ID_SENTINEL,
  CONSOLE_BUILD_ID_HEADER,
  CONSOLE_BUILD_VERDICTS,
  UNKNOWN_VERSION_VALUE,
} = require(path.join(here, '..', 'dist', 'index.js'));

const API = 'v0.47.0';

// ---- the two verdicts that serve ------------------------------------------

test('the same release is a match', () => {
  assert.equal(
    compareConsoleBuild({ presented: API, apiVersion: API }),
    'match',
  );
});

test('an api that does not know its own version refuses nothing', () => {
  // A source build with no CAP_VERSION reports "unknown". Refusing every console
  // against it would break the ordinary development loop to enforce an invariant
  // that only means anything between two DEPLOYED artifacts.
  for (const apiVersion of [UNKNOWN_VERSION_VALUE, '', '   ']) {
    for (const presented of [null, undefined, 'dev', 'v0.1.0', API]) {
      assert.equal(
        compareConsoleBuild({ presented, apiVersion }),
        'api-unversioned',
        `apiVersion=${JSON.stringify(apiVersion)} presented=${JSON.stringify(presented)}`,
      );
    }
  }
});

// ---- the two verdicts that refuse -----------------------------------------

test('a different release is a mismatch', () => {
  assert.equal(
    compareConsoleBuild({ presented: 'v0.46.1', apiVersion: API }),
    'mismatch',
  );
});

test('absence and the sentinel are the same verdict', () => {
  // A deployed console that presents neither is a deployment that never received
  // its version — the state that let one deployment path stay unplumbed while
  // looking identical to a laptop build.
  for (const presented of [null, undefined, '', '   ', CONSOLE_BUILD_ID_SENTINEL]) {
    assert.equal(
      compareConsoleBuild({ presented, apiVersion: API }),
      'unidentified',
      `presented=${JSON.stringify(presented)}`,
    );
  }
});

test('whitespace does not turn a match into a mismatch', () => {
  // A header value picks up padding in transit more often than anyone expects,
  // and a gate that refuses on it would be refusing on nothing.
  assert.equal(
    compareConsoleBuild({ presented: `  ${API}  `, apiVersion: `${API} ` }),
    'match',
  );
});

// ---- what the operator is told --------------------------------------------

test('a mismatch refusal names BOTH versions', () => {
  const message = describeConsoleBuildRefusal({
    verdict: 'mismatch',
    presented: 'v0.46.1',
    apiVersion: API,
  });
  assert.match(message, /v0\.46\.1/);
  assert.match(message, /v0\.47\.0/);
});

test('an unidentified refusal names the one version that is known', () => {
  const message = describeConsoleBuildRefusal({
    verdict: 'unidentified',
    presented: CONSOLE_BUILD_ID_SENTINEL,
    apiVersion: API,
  });
  assert.match(message, /v0\.47\.0/);
});

test('a served verdict produces no message', () => {
  for (const verdict of ['match', 'api-unversioned']) {
    assert.equal(
      describeConsoleBuildRefusal({ verdict, presented: API, apiVersion: API }),
      null,
    );
  }
});

// ---- the vocabulary --------------------------------------------------------

test('every declared verdict is reachable from the comparison', () => {
  // A verdict nothing can produce is a branch nothing tests, which is how a
  // vocabulary drifts from the code that is supposed to use it.
  const produced = new Set([
    compareConsoleBuild({ presented: API, apiVersion: API }),
    compareConsoleBuild({ presented: 'v0.1.0', apiVersion: API }),
    compareConsoleBuild({ presented: null, apiVersion: API }),
    compareConsoleBuild({ presented: API, apiVersion: UNKNOWN_VERSION_VALUE }),
  ]);
  assert.deepEqual([...produced].sort(), [...CONSOLE_BUILD_VERDICTS].sort());
});

test('the header name is lowercase, because header lookup is', () => {
  assert.equal(CONSOLE_BUILD_ID_HEADER, CONSOLE_BUILD_ID_HEADER.toLowerCase());
});
