## ADDED Requirements

### Requirement: A cache-only Worker transparently proxies GitHub releases/latest

The mirror SHALL be a Cloudflare Worker exposing `GET /repos/{owner}/{repo}/releases/latest`
that proxies the request to GitHub's `https://api.github.com/repos/{owner}/{repo}/releases/latest`
and returns GitHub's response body and status code UNCHANGED. The response SHALL be
served through Cloudflare's edge cache with a short TTL so repeated lookups across the
fleet are served from cache instead of re-hitting GitHub. The Worker SHALL add NO
authentication and SHALL NOT rewrite the release payload — it is a pure cache layer,
with no release gating, version rewriting, or telemetry. A transient upstream error
SHALL NOT be cached as a durable answer.

#### Scenario: Proxies a release lookup unchanged

- **WHEN** a client requests `GET /repos/{owner}/{repo}/releases/latest`
- **THEN** the Worker returns GitHub's `releases/latest` body and status for that repo, byte-for-byte unchanged

#### Scenario: Repeated lookups are served from the edge cache

- **WHEN** the same path is requested again within the cache TTL
- **THEN** it is served from Cloudflare's edge cache without a new GitHub fetch (observable as a cache hit), converging the fleet onto one upstream request per TTL

#### Scenario: A missing release or upstream error is not cached as success

- **WHEN** GitHub returns 404 (no published release) or a 5xx error
- **THEN** the Worker reflects that status, caches a 404 only briefly, and does NOT cache a 5xx — so a transient GitHub error never sticks as the served answer

### Requirement: The proxy validates owner/repo and never proxies an arbitrary URL

The Worker SHALL serve ONLY paths matching the shape `/repos/{owner}/{repo}/releases/latest`
where `owner` and `repo` are well-formed segments (e.g. `[\w.-]+`), and SHALL reject any
other path with 404 and make no upstream request — so the public, unauthenticated endpoint
can never be coerced into proxying an arbitrary URL or a different GitHub endpoint. It SHALL
accept ANY well-formed `owner/repo` (no fixed allowlist), so a self-hoster whose
`GITHUB_RELEASES_REPO` points at a fork is still served through the mirror.

#### Scenario: Rejects a non-matching path

- **WHEN** a request targets any path other than the `releases/latest` shape (a different GitHub endpoint, extra path segments, or a query-based override)
- **THEN** the Worker responds 404 and makes no upstream GitHub fetch

#### Scenario: Accepts a well-formed fork repo

- **WHEN** the `owner/repo` is well-formed but is a fork rather than the canonical cap repo
- **THEN** the Worker proxies it normally (no allowlist), so a self-hoster's forked `GITHUB_RELEASES_REPO` works through the mirror
