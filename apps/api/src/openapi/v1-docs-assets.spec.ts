import assert from 'node:assert/strict';
import test from 'node:test';

import { buildV1DocsHtml } from './openapi.registry';

/**
 * `GET /v1/docs` is in the unauthenticated allowlist, so it is an anonymously
 * reachable page on the SAME origin as the authenticated API. Whatever it loads
 * executes there, with the operator's cookies in scope.
 *
 * A remote script is only safe to execute if the exact bytes are pinned: an
 * exact version so the reference cannot move, and an integrity hash so a swapped
 * artefact fails closed instead of running. `crossorigin` alone is not that — it
 * is the CORS mode SRI *requires*, not SRI itself.
 *
 * Same-origin assets are fine: they are ours, and they ship with the image.
 */

/** `src`/`href` values pointing somewhere other than this origin. */
function remoteAssetUrls(html: string): string[] {
  const urls: string[] = [];
  for (const match of html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)) {
    const url = match[1];
    if (/^https?:\/\//i.test(url) || url.startsWith('//')) urls.push(url);
  }
  return urls;
}

/** The tag that carries a given URL, so integrity can be checked on it. */
function tagFor(html: string, url: string): string {
  const match = html.match(
    new RegExp(`<(?:script|link)\\b[^>]*${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^>]*>`, 'i'),
  );
  assert.ok(match, `expected to find the tag carrying ${url}`);
  return match[0];
}

/**
 * A pinned reference names an exact version. Package CDNs treat a bare package
 * path as "whatever is newest", which is the moving target this forbids.
 */
function looksPinned(url: string): boolean {
  return /@\d+\.\d+\.\d+/.test(url) || /\/\d+\.\d+\.\d+\//.test(url);
}

test('the docs page references no unpinned remote asset', () => {
  const html = buildV1DocsHtml();
  const unpinned = remoteAssetUrls(html).filter((url) => !looksPinned(url));
  assert.deepEqual(
    unpinned,
    [],
    'a version-less package URL resolves to whatever the CDN serves today',
  );
});

test('every remote asset on the docs page carries an integrity hash', () => {
  const html = buildV1DocsHtml();
  const missing = remoteAssetUrls(html).filter(
    (url) => !/\bintegrity\s*=\s*"[^"]+"/i.test(tagFor(html, url)),
  );
  assert.deepEqual(missing, [], 'a remote asset without SRI executes unverified');
});

test('any remote asset declaring integrity also declares crossorigin', () => {
  // SRI is only enforced when the request is made in CORS mode; without
  // `crossorigin` the hash is silently ignored by the browser.
  const html = buildV1DocsHtml();
  for (const url of remoteAssetUrls(html)) {
    const tag = tagFor(html, url);
    if (!/\bintegrity=/i.test(tag)) continue;
    assert.match(tag, /\bcrossorigin\b/i, `${url}: integrity without crossorigin is inert`);
  }
});

test('the spec URL the page loads is still same-origin', () => {
  // A regression here would mean the docs page fetching its contract from
  // somewhere other than this API.
  const html = buildV1DocsHtml();
  assert.match(html, /"\/v1\/openapi\.json"/, 'the default spec URL is same-origin');
});
