## ADDED Requirements

### Requirement: The release-lookup upstream is configurable and defaults to the cache mirror

The GitHub-Release lookup SHALL build its request against a configurable base URL via a
`GITHUB_API_BASE` environment variable, replacing the previously hard-coded
`https://api.github.com`. The default SHALL be the official cache-only mirror, so update
checks route through the mirror out of the box. Setting `GITHUB_API_BASE=https://api.github.com`
SHALL restore a fully-direct, zero-dependency lookup — this escape hatch is REQUIRED and
documented for self-hosters. Changing the base SHALL change ONLY the host the lookup
targets: the request path (`/repos/{repo}/releases/latest`), headers, the in-process TTL
cache + coalescing, the honest-degrade behavior, and the `GITHUB_RELEASES_REPO` semantics
SHALL all be unchanged. A trailing slash on the configured base SHALL be tolerated.

#### Scenario: Default routes update checks through the mirror

- **WHEN** `GITHUB_API_BASE` is unset
- **THEN** the lookup targets the official mirror base, requesting `{mirror}/repos/{repo}/releases/latest`, and `GET /update-status` behaves exactly as before apart from the upstream host

#### Scenario: Escape hatch restores direct GitHub

- **WHEN** an operator sets `GITHUB_API_BASE=https://api.github.com`
- **THEN** the lookup targets GitHub directly with identical path, headers, caching, coalescing, and degrade behavior

#### Scenario: A failing upstream still degrades honestly regardless of base

- **WHEN** the configured base (mirror or direct) is unreachable or returns a non-OK status
- **THEN** `GET /update-status` degrades honestly (`updateAvailable: false`, `latestVersion: null`) without throwing, exactly as a direct-GitHub failure does today
