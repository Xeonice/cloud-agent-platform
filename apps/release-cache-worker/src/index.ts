import {
  buildUpstreamUrl,
  cacheCfOptions,
  GITHUB_HEADERS,
  parseReleasesPath,
} from './proxy.js';

/** The mirror is stateless and unauthenticated — no bindings. */
export type Env = Record<string, never>;

/**
 * Public, cache-only release-check mirror (release-check-mirror).
 *
 * Transparently proxies `GET /repos/{owner}/{repo}/releases/latest` to GitHub and
 * returns GitHub's body + status UNCHANGED, served through Cloudflare's edge cache
 * (see {@link cacheCfOptions}). It is a pure cache layer: no auth, no GitHub token,
 * no telemetry, no payload rewrite. Any path that is not the exact `releases/latest`
 * shape is rejected with 404 WITHOUT an upstream fetch, so the open endpoint can
 * never be coerced into proxying an arbitrary URL.
 *
 * MUST run behind a custom domain on a CF zone — edge caching is inoperative on
 * `*.workers.dev` (see wrangler.toml).
 */
export default {
  async fetch(request: Request): Promise<Response> {
    // GET only (task 1.2). Rejecting HEAD too avoids a separate upstream fetch the
    // GET edge cache can't serve, and keeps the surface minimal.
    if (request.method !== 'GET') {
      return new Response('method not allowed', { status: 405 });
    }

    const ref = parseReleasesPath(new URL(request.url).pathname);
    if (!ref) {
      return new Response('not found', { status: 404 });
    }

    // Pure pass-through with edge caching: GitHub's response is returned unchanged.
    return fetch(buildUpstreamUrl(ref), {
      headers: GITHUB_HEADERS,
      cf: cacheCfOptions(),
    });
  },
} satisfies ExportedHandler<Env>;
