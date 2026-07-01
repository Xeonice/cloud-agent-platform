/**
 * Schema validation for the asciicast v2 terminal-replay shapes
 * (session-terminal-replay, task 1.3). Drives the REAL compiled zod schemas from
 * dist/. Guards that a valid header + o/r events parse, that a malformed line is
 * rejected WITHOUT aborting the whole parse, and that the endpoint path/content-
 * type contracts are stable.
 *
 * Requires `pnpm --filter @cap/contracts build` first. Run: `node asciicast.test.mjs`.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  ASCIICAST_VERSION,
  AsciicastHeaderSchema,
  AsciicastEventSchema,
  CAST_CONTENT_TYPE,
  castEndpointPath,
  parseAsciicastHeader,
  parseAsciicastEvent,
  parseCast,
  castDurationSeconds,
} = require(path.join(here, '../dist/asciicast.js'));

test('version is 2', () => {
  assert.equal(ASCIICAST_VERSION, 2);
});

test('valid header parses', () => {
  const h = { version: 2, width: 120, height: 40, timestamp: 1718600000 };
  assert.equal(AsciicastHeaderSchema.safeParse(h).success, true);
  const parsed = parseAsciicastHeader(JSON.stringify(h));
  assert.equal(parsed.width, 120);
  assert.equal(parsed.height, 40);
});

test('header with wrong version / bad geometry / non-json is rejected', () => {
  assert.equal(AsciicastHeaderSchema.safeParse({ version: 3, width: 80, height: 24 }).success, false);
  assert.equal(parseAsciicastHeader('{"version":2,"width":0,"height":24}'), null);
  assert.equal(parseAsciicastHeader('not json'), null);
});

test('o and r events parse', () => {
  assert.equal(AsciicastEventSchema.safeParse([0.5, 'o', 'hello']).success, true);
  assert.equal(AsciicastEventSchema.safeParse([1.2, 'r', '120x40']).success, true);
  const ev = parseAsciicastEvent('[0.213,"o","\\u001b[32mhi\\u001b[0m"]');
  assert.equal(ev[0], 0.213);
  assert.equal(ev[1], 'o');
  assert.equal(ev[2], '[32mhi[0m');
});

test('malformed / unknown-code event is rejected (null, no throw)', () => {
  assert.equal(parseAsciicastEvent('[0.1,"x","data"]'), null); // unknown code
  assert.equal(parseAsciicastEvent('[0.1,"o"]'), null); // missing data
  assert.equal(parseAsciicastEvent('garbage'), null);
});

test('parseCast: header + events, malformed lines skipped', () => {
  const text = [
    '{"version":2,"width":80,"height":24,"timestamp":1718600000}',
    '[0.0,"o","first"]',
    'THIS LINE IS GARBAGE',
    '[0.5,"r","100x30"]',
    '[1.0,"o","last"]',
    '',
  ].join('\n');
  const { header, events } = parseCast(text);
  assert.equal(header.width, 80);
  assert.equal(events.length, 3); // garbage dropped, blank skipped
  assert.equal(events[0][2], 'first');
  assert.equal(events[1][1], 'r');
  assert.equal(castDurationSeconds(events), 1.0);
});

test('parseCast stops before legacy mid-file headers', () => {
  const text = [
    '{"version":2,"width":80,"height":24,"timestamp":1782894858}',
    '[13608.181,"o","before restart\\r\\n"]',
    '{"version":2,"width":80,"height":24,"timestamp":1782910173}',
    '[0.147,"o","tmux -u new-session ...\\r\\n"]',
    '[0.2,"o","duplicate session: task12c791c7\\r\\n"]',
  ].join('\n');
  const { events } = parseCast(text);
  assert.equal(events.length, 1);
  assert.equal(events[0][2], 'before restart\r\n');
});

test('parseCast stops before legacy time regressions', () => {
  const text = [
    '{"version":2,"width":80,"height":24,"timestamp":1782894858}',
    '[10,"o","first"]',
    '[11,"o","second"]',
    '[0.5,"o","regressed bootstrap"]',
    '[0.6,"o","more bootstrap"]',
  ].join('\n');
  const { events } = parseCast(text);
  assert.deepEqual(events.map((event) => event[2]), ['first', 'second']);
});

test('parseCast on empty text yields empty', () => {
  const { header, events } = parseCast('');
  assert.equal(header, null);
  assert.equal(events.length, 0);
  assert.equal(castDurationSeconds(events), 0);
});

test('endpoint path + content type contracts', () => {
  assert.equal(castEndpointPath('abc123'), 'tasks/abc123/cast');
  assert.equal(CAST_CONTENT_TYPE, 'text/plain; charset=utf-8');
});
