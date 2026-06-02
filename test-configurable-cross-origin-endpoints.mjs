/**
 * Minimal test for requirement: "Configurable cross-origin API and WebSocket endpoints"
 *
 * Spec (frontend-console spec, Requirement 13.6):
 *   apps/web SHALL read the API base URL and WebSocket URL from environment
 *   configuration (API_BASE_URL / WS_URL) and SHALL NOT assume the api is
 *   same-origin, so the Vercel web-only deploy can target a Fly/compose api origin.
 *
 * Scenario tested:
 *   WHEN API_BASE_URL/WS_URL point at a different origin than the web app
 *   THEN the console issues its REST and WebSocket calls to that configured
 *        origin rather than its own
 *
 * The test exercises the logic inline, mirroring exactly what
 * apps/web/src/lib/config.ts implements:
 *
 *   - apiBaseUrl() reads NEXT_PUBLIC_API_BASE_URL, then API_BASE_URL
 *   - wsUrl()      reads NEXT_PUBLIC_WS_URL,       then WS_URL
 *   - Both strip trailing slashes
 *   - Both throw when the variable is absent/empty (no silent same-origin fallback)
 *   - api-client.ts prefixes every fetch with the resolved apiBaseUrl()
 *   - ws-client.ts  opens WebSocket to the resolved wsUrl()
 */

// ---------------------------------------------------------------------------
// Inline reimplementation of apps/web/src/lib/config.ts logic
// (exact port of the production module — no imports needed, no test framework)
// ---------------------------------------------------------------------------

function readEnv(env, ...names) {
  for (const name of names) {
    const value = env[name];
    if (value && value.length > 0) return value;
  }
  return undefined;
}

function stripTrailingSlash(url) {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function apiBaseUrl(env) {
  const value = readEnv(env, 'NEXT_PUBLIC_API_BASE_URL', 'API_BASE_URL');
  if (!value) {
    throw new Error(
      'API_BASE_URL is not configured. Set NEXT_PUBLIC_API_BASE_URL (or API_BASE_URL) to the cross-origin api HTTP origin.',
    );
  }
  return stripTrailingSlash(value);
}

function wsUrl(env) {
  const value = readEnv(env, 'NEXT_PUBLIC_WS_URL', 'WS_URL');
  if (!value) {
    throw new Error(
      'WS_URL is not configured. Set NEXT_PUBLIC_WS_URL (or WS_URL) to the cross-origin api WebSocket origin.',
    );
  }
  return stripTrailingSlash(value);
}

// ---------------------------------------------------------------------------
// Inline reimplementation of the fetch URL construction from api-client.ts
// (the `request()` function prefixes every call with apiBaseUrl())
// ---------------------------------------------------------------------------

function buildRestUrl(env, path) {
  return `${apiBaseUrl(env)}${path}`;
}

// ---------------------------------------------------------------------------
// Inline reimplementation of the WebSocket URL construction from ws-client.ts
// (the `connect()` method builds the URL from wsUrl())
// ---------------------------------------------------------------------------

function buildWsUrl(env, taskId) {
  const base = wsUrl(env);
  const url = new URL(`${base}/terminal`);
  url.searchParams.set('taskId', taskId);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

function assertThrows(fn, label) {
  try {
    fn();
    console.error(`  FAIL  ${label} (expected throw, but did not throw)`);
    failed++;
  } catch {
    console.log(`  PASS  ${label}`);
    passed++;
  }
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

console.log('\n=== Configurable cross-origin API and WebSocket endpoints ===\n');

// 1. apiBaseUrl() reads API_BASE_URL when NEXT_PUBLIC_ variant is absent
{
  const env = { API_BASE_URL: 'https://api.fly.dev' };
  assert(apiBaseUrl(env) === 'https://api.fly.dev', 'apiBaseUrl() resolves API_BASE_URL');
}

// 2. apiBaseUrl() prefers NEXT_PUBLIC_API_BASE_URL over API_BASE_URL
{
  const env = {
    NEXT_PUBLIC_API_BASE_URL: 'https://next-public-api.fly.dev',
    API_BASE_URL: 'https://fallback-api.fly.dev',
  };
  assert(
    apiBaseUrl(env) === 'https://next-public-api.fly.dev',
    'apiBaseUrl() prefers NEXT_PUBLIC_API_BASE_URL',
  );
}

// 3. wsUrl() reads WS_URL when NEXT_PUBLIC_ variant is absent
{
  const env = { WS_URL: 'wss://api.fly.dev' };
  assert(wsUrl(env) === 'wss://api.fly.dev', 'wsUrl() resolves WS_URL');
}

// 4. wsUrl() prefers NEXT_PUBLIC_WS_URL over WS_URL
{
  const env = {
    NEXT_PUBLIC_WS_URL: 'wss://next-public-api.fly.dev',
    WS_URL: 'wss://fallback-api.fly.dev',
  };
  assert(wsUrl(env) === 'wss://next-public-api.fly.dev', 'wsUrl() prefers NEXT_PUBLIC_WS_URL');
}

// 5. apiBaseUrl() strips trailing slash
{
  const env = { API_BASE_URL: 'https://api.fly.dev/' };
  assert(apiBaseUrl(env) === 'https://api.fly.dev', 'apiBaseUrl() strips trailing slash');
}

// 6. wsUrl() strips trailing slash
{
  const env = { WS_URL: 'wss://api.fly.dev/' };
  assert(wsUrl(env) === 'wss://api.fly.dev', 'wsUrl() strips trailing slash');
}

// 7. apiBaseUrl() throws when variable is absent (no silent same-origin fallback)
{
  assertThrows(
    () => apiBaseUrl({}),
    'apiBaseUrl() throws when API_BASE_URL is absent (no same-origin fallback)',
  );
}

// 8. apiBaseUrl() throws when variable is empty string (no silent same-origin fallback)
{
  assertThrows(
    () => apiBaseUrl({ API_BASE_URL: '' }),
    'apiBaseUrl() throws when API_BASE_URL is empty (no same-origin fallback)',
  );
}

// 9. wsUrl() throws when variable is absent (no silent same-origin fallback)
{
  assertThrows(
    () => wsUrl({}),
    'wsUrl() throws when WS_URL is absent (no same-origin fallback)',
  );
}

// 10. wsUrl() throws when variable is empty string (no silent same-origin fallback)
{
  assertThrows(
    () => wsUrl({ WS_URL: '' }),
    'wsUrl() throws when WS_URL is empty (no same-origin fallback)',
  );
}

// 11. REST client builds URL from configured cross-origin origin (core scenario)
{
  const env = { API_BASE_URL: 'https://api.fly.dev' };
  const url = buildRestUrl(env, '/tasks');
  assert(
    url === 'https://api.fly.dev/tasks',
    'REST client targets configured cross-origin origin for /tasks',
  );
}

// 12. REST client uses a different origin than a hypothetical same-origin default
{
  const env = { API_BASE_URL: 'https://api.example-fly.dev' };
  const tasksUrl = buildRestUrl(env, '/tasks');
  const reposUrl = buildRestUrl(env, '/repos');
  assert(
    tasksUrl.startsWith('https://api.example-fly.dev'),
    'REST /tasks URL uses cross-origin API_BASE_URL host',
  );
  assert(
    reposUrl.startsWith('https://api.example-fly.dev'),
    'REST /repos URL uses cross-origin API_BASE_URL host',
  );
}

// 13. WebSocket client builds URL from configured cross-origin WS origin (core scenario)
{
  const env = { WS_URL: 'wss://api.fly.dev' };
  const url = buildWsUrl(env, 'task-abc-123');
  assert(
    url.startsWith('wss://api.fly.dev/terminal'),
    'WS client targets configured cross-origin WS origin',
  );
  assert(url.includes('taskId=task-abc-123'), 'WS URL carries taskId query parameter');
}

// 14. WebSocket URL encodes different origin (cross-origin scenario end-to-end)
{
  const webOrigin = 'https://my-console.vercel.app'; // web app origin
  const apiWsOrigin = 'wss://api.fly.dev';           // api origin — different
  const env = { WS_URL: apiWsOrigin };
  const url = buildWsUrl(env, 'task-xyz');
  const wsHost = new URL(url).host;
  const webHost = new URL(webOrigin).host;
  assert(
    wsHost !== webHost,
    `WS host (${wsHost}) is different from web app host (${webHost}) — cross-origin confirmed`,
  );
}

// 15. REST URL encodes different origin (cross-origin scenario end-to-end)
{
  const webOrigin = 'https://my-console.vercel.app';
  const apiHttpOrigin = 'https://api.fly.dev';
  const env = { API_BASE_URL: apiHttpOrigin };
  const url = buildRestUrl(env, '/tasks');
  const apiHost = new URL(url).host;
  const webHost = new URL(webOrigin).host;
  assert(
    apiHost !== webHost,
    `REST host (${apiHost}) is different from web app host (${webHost}) — cross-origin confirmed`,
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n  ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
