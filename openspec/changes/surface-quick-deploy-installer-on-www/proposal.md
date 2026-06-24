## Why

The prebuilt-image, no-OAuth `scripts/quick-deploy.sh` (shipped in PR #62) is the fast,
agent-drivable bring-up — but it lives only in the repo. The marketing site exposes only the
**source-build** one-liner (`curl … /install.sh | sh`, which wraps `make up`). So a visitor or
agent who wants the fast prebuilt path has to clone first, defeating the "one command from the
site" promise. This closes the Open Question recorded in the `add-agent-oneclick-prebuilt-deploy`
design: surface `quick-deploy.sh` as a second site-hosted one-liner.

## What Changes

- **Serve `quick-deploy.sh` from the site** at `https://<domain>/quick-deploy.sh`, consumable as
  `curl -fsSL https://<domain>/quick-deploy.sh | bash`. `scripts/quick-deploy.sh` stays the single
  source-of-truth; the existing build step (`apps/www/scripts/inject-install-sh.mjs`) is EXTENDED
  to stage it into the static export `out/` and substitute build-time markers — no second build
  system, no duplicated script.
- **Serve `docker-compose.prod.yml` as a static site asset** (`https://<domain>/docker-compose.prod.yml`),
  staged at build, so a site-hosted run is self-contained and version-consistent with the site —
  not dependent on a GitHub branch at runtime.
- **`quick-deploy.sh` gains a compose-base marker.** The published copy defaults its fetch base
  to the site itself (so it pulls the site's `docker-compose.prod.yml`); the committed repo copy
  keeps an in-file fallback (raw GitHub) and still prefers a repo-local compose when run from a
  clone; `CAP_RAW_BASE` remains an override. No placeholders in the published file.
- **Landing page shows a second install command** (bilingual en/zh) next to the source one-liner:
  the prebuilt/agent one-liner, clearly labelled **amd64-only**, **legacy-token (not OAuth-first
  production)**, **host-root via `docker.sock`**, and **prebuilt `cap-web` localhost-only**, with
  the inspectable script URL disclosed (same auditable posture as `install.sh`).
- **Fix the `quick-deploy.sh` teardown hint:** when `WITH_WEB=1`, the printed `down:` command must
  include `COMPOSE_PROFILES=web`, because `docker compose down` without the profile leaves the
  profile-gated `cap-web` running (observed live).
- The existing `install.sh` source-build path is unchanged and remains the first one-liner; the
  two commands are clearly distinguished by when to use each.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `one-line-installer`: ADD that the site also hosts the prebuilt `quick-deploy.sh` (built from
  the repo source-of-truth with build-time marker substitution) and serves
  `docker-compose.prod.yml` as a static asset, with the same "served as plain text / auditable /
  manual alternative disclosed" guarantees as the existing install script.
- `marketing-www`: the landing's install presentation is extended to show TWO one-liners — the
  existing source-build `install.sh` and the new prebuilt `quick-deploy.sh` — each with its
  caveats, bilingual.
- `agent-oneclick-deploy`: the compose fetch base defaults to the published site when the script
  is served (repo-local when run from a clone; `CAP_RAW_BASE` overrides); and the printed teardown
  hint is correct for the `web` profile.

## Impact

- Modified: `apps/www/scripts/inject-install-sh.mjs` (stage + marker-inject `quick-deploy.sh`;
  stage `docker-compose.prod.yml` into `out/`).
- Modified: `scripts/quick-deploy.sh` (compose-base marker + in-file fallback; teardown hint).
- Modified: `apps/www/content/en.ts` + `apps/www/content/zh.ts` and the relevant landing
  section component(s) (second install command + caveats).
- No backend/runtime change; no change to `docker-compose.prod.yml` content. Static-export +
  Vercel deploy model unchanged. The published `cap-web` localhost caveat is unchanged and now
  surfaced on the site.
