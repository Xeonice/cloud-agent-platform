## Context

PR #62 shipped `scripts/quick-deploy.sh` (prebuilt-image, no-OAuth, agent-drivable) but left it
repo-only, with an Open Question about surfacing it on the site. The site already hosts
`install.sh` (source-build path) via a clean static-asset model: `apps/www/public/install.sh` is
the inspectable source-of-truth with `__CAP_*__` markers, `next build` (`output: 'export'`) copies
`public/*` into `out/`, and `apps/www/scripts/inject-install-sh.mjs` rewrites `out/install.sh` in
place to substitute the markers (repo URL, site domain) with literal build-time values, stripping
the now-dead in-file fallback `case` arms. No backend; served as plain text.

The wrinkle: `quick-deploy.sh`'s source-of-truth is `scripts/quick-deploy.sh` (repo root), NOT
under `apps/www/public/`, so `next build` does not auto-copy it. And the prebuilt path needs a
`docker-compose.prod.yml` at runtime, which a site-hosted `curl | sh` cannot get from a clone.

## Goals / Non-Goals

**Goals:**
- A second site-hosted one-liner `curl … /quick-deploy.sh | bash` with no backend, built from the
  repo source-of-truth (no duplicate script), markers resolved at build.
- A site-hosted `docker-compose.prod.yml` so the run is self-contained and version-consistent.
- Landing UI: a second install command with its caveats, bilingual.
- Fix the `quick-deploy.sh` teardown hint for the `web` profile.

**Non-Goals:**
- Changing the `install.sh` source-build path or the OAuth-first production guidance.
- Changing `docker-compose.prod.yml` content or any backend/runtime code.
- A site-hosted variant that is OAuth-first (this surfaces the legacy-token trial path with its
  caveats stated, not a new production posture).
- Pinning the site asset to a specific Release (it tracks the deployed site's repo state; runtime
  image tag is still controlled by `CAP_VERSION`, default `latest`).

## Decisions

- **Extend `inject-install-sh.mjs`, do not add a second build script.** It already runs
  post-`next build` and owns marker substitution. It gains two staging steps: copy
  `<repo>/scripts/quick-deploy.sh` → `out/quick-deploy.sh` and substitute a compose-base/domain
  marker; copy `<repo>/docker-compose.prod.yml` → `out/docker-compose.prod.yml`. One build owner,
  consistent with the existing install.sh handling. Alternative considered: a `public/quick-deploy.sh`
  duplicate — rejected (drift from `scripts/quick-deploy.sh`, the canonical, tested copy).
- **`quick-deploy.sh` gets a `__CAP_COMPOSE_BASE__` marker with an in-file fallback.** The
  published copy's fetch base becomes the site (so it pulls the site's `docker-compose.prod.yml`);
  the committed repo copy keeps the raw-GitHub fallback via the `case … __CAP_COMPOSE_BASE__)` arm
  (mirroring how `install.sh` keeps its repo/domain fallbacks). `CAP_RAW_BASE` still overrides;
  GATE 4's repo-local-first logic is unchanged so a clone run is unaffected. The injector strips
  the dead fallback arm only when the marker is actually substituted (same rule as install.sh).
- **Serve `docker-compose.prod.yml` from the site.** Makes a `curl | sh` run self-contained and
  version-consistent with what the site advertises, with no GitHub-branch runtime dependency.
  `CAP_RAW_BASE` remains the escape hatch. Alternative considered: fetch from a GitHub Release
  asset — deferred; the static site asset is simpler and matches the existing no-backend model.
- **Landing shows two commands, source first.** `install.sh` (broad compatibility) stays the
  primary; `quick-deploy.sh` is the "faster, amd64" option with explicit caveats. Copy lives in
  `content/en.ts` + `content/zh.ts`; rendering reuses the existing Hero command-block + copy
  control + inspectable-URL pattern so the second command inherits the auditable posture.
- **Teardown-hint fix travels with the now-public script.** Since `quick-deploy.sh` becomes
  user-facing, the `down:` line must include `COMPOSE_PROFILES=web` when `WITH_WEB=1` (observed:
  a bare `docker compose down` orphans the profile-gated `cap-web`).

## Risks / Trade-offs

- [Two `curl | sh` commands confuse visitors] → Source-build is presented first as the default;
  the prebuilt one is explicitly labelled amd64-only / legacy-token / host-root / localhost-web so
  the choice and its caveats are clear.
- [Site asset `docker-compose.prod.yml` drifts from a pinned Release] → It tracks the deployed
  site's repo state and `CAP_VERSION` (default `latest`) controls the image tags; pinning is an
  override, not the default, consistent with the prod compose's own model.
- [Injector regex edits the wrong line] → Reuse the proven marker-substitution + fallback-arm-strip
  approach already used for install.sh; a build-output assertion (published file has no `__CAP_`
  placeholder) guards it.
- [Published `cap-web` localhost-only mistaken for production] → Stated in the landing caveat copy
  and the served script header; the OAuth-first guide remains the documented production path.

## Migration Plan

Additive: a new served script + a served compose asset + a second landing command + one script
hint fix. No data/schema/runtime change. Rollback = revert the files; the `install.sh` path and
all backend behavior are untouched. Deploy via the existing Vercel static-export pipeline for
`apps/www`.

## Open Questions

- Should the site also offer a Release-pinned variant of the prebuilt command (e.g. a copyable
  `CAP_VERSION=vX.Y.Z` form) for reproducible installs? (Lean: not now — `CAP_VERSION` is already
  an env override documented in `self-hosting.md`.)
