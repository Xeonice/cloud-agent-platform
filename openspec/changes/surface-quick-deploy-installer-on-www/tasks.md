<!-- Track-annotated tasks. Tracks touch disjoint files where possible; tasks within
     a track are serial. -->

## 1. Track: quick-deploy-script (depends: none)

- [x] 1.1 In `scripts/quick-deploy.sh`, add a `__CAP_COMPOSE_BASE__` marker for the fetch base:
      `RAW_BASE="${CAP_RAW_BASE:-__CAP_COMPOSE_BASE__}"` plus an in-file fallback `case` arm that
      restores the raw-GitHub default when the marker is unsubstituted (mirrors install.sh's
      repo/domain fallback) — committed-source behavior unchanged, `CAP_RAW_BASE` still overrides,
      GATE 4 repo-local-first logic untouched (Requirement: Scripted source-free prebuilt-image
      bring-up — compose fetch base resolves by run context)
- [x] 1.2 Fix GATE 7's printed `down:` hint so that when `WITH_WEB=1` it includes
      `COMPOSE_PROFILES=web` (a bare `docker compose down` orphans the profile-gated `cap-web`)
      (Requirement: Health verification and credential surfacing — teardown hint matches profiles)
- [x] 1.3 `bash -n scripts/quick-deploy.sh` clean; confirm the committed copy still runs standalone
      via the fallback (marker-unsubstituted) and `CAP_RAW_BASE` override path

## 2. Track: www-build-injector (depends: quick-deploy-script)

- [x] 2.1 In `apps/www/scripts/inject-install-sh.mjs`, stage `<repo>/scripts/quick-deploy.sh` into
      `out/quick-deploy.sh` and substitute `__CAP_COMPOSE_BASE__` (and any domain marker) with the
      build-time site value; strip the dead fallback arm only when substituted; warn (don't fail)
      when the site env is unset (mirror the install.sh handling) (Requirement: Site-hosted prebuilt
      one-line installer)
- [x] 2.2 In the same build step, stage `<repo>/docker-compose.prod.yml` into
      `out/docker-compose.prod.yml` (Requirement: Site-hosted prod compose asset)
- [x] 2.3 Add a build-output assertion: published `out/quick-deploy.sh` contains no `__CAP_`
      placeholder when the site env is provided (Requirement: Site-hosted prebuilt one-line
      installer — markers resolved)

## 3. Track: www-landing-content (depends: none)

- [x] 3.1 In `apps/www/content/en.ts` and `apps/www/content/zh.ts`, add the second install command
      (`curl … /quick-deploy.sh | bash`) and its caveat copy (amd64-only, legacy-token not OAuth-first
      production, host-root via docker.sock, prebuilt cap-web localhost-only) in both locales
      (Requirement: Landing information architecture — prebuilt command; bilingual)
- [x] 3.2 Update the landing section component(s) (e.g. `components/sections/hero.tsx`) to render the
      second command with a copy-to-clipboard control and the inspectable `quick-deploy.sh` URL,
      reusing the existing command-block pattern; source-build command stays primary/first
      (Requirement: Landing information architecture; Prebuilt installer is auditable)

## 4. Track: verify (depends: quick-deploy-script, www-build-injector, www-landing-content)

- [x] 4.1 Static review: source-of-truth single (`scripts/quick-deploy.sh`, no duplicate);
      injector stages both files + substitutes/strips correctly; landing shows two commands +
      caveats in both locales; install.sh path untouched; teardown hint includes web profile
- [x] 4.2 Build `apps/www` with the site env set; assert `out/quick-deploy.sh` and
      `out/docker-compose.prod.yml` exist, the script has no `__CAP_` placeholder and its fetch base
      is the site, and the landing renders both commands (en + zh)
- [x] 4.3 Live (amd64 / WSL2) smoke: serve `out/` locally (or against the deployed preview), run
      `curl -fsSL <served>/quick-deploy.sh | bash`, confirm it fetches the served compose, brings up
      api/web/postgres, `/health` 200, legacy-bearer `/tasks` 200, and the printed teardown command
      removes `cap-web`

## Track: verify-reopened (depends: none)

- [x] R.1 Add the prebuilt path's equivalent manual alternative to the landing hero so the
      "Inspectable URL and manual alternative disclosed" scenario is satisfied. The spec requires
      that alongside the inspectable `quick-deploy.sh` URL, "the equivalent manual steps (download
      `docker-compose.prod.yml`, run the prebuilt compose) are presented" — currently only the
      source-build `git clone && make up` manual block exists; `hero.prebuilt` has no `manual`
      field. Add a prebuilt manual block (download the served `docker-compose.prod.yml`, then
      `docker compose -f docker-compose.prod.yml up -d` / equivalent prebuilt-compose steps) in both
      `content/en.ts` and `content/zh.ts`, and render it in `components/sections/hero.tsx` next to
      the prebuilt command, so users are not required to pipe the unreviewed prebuilt script to a
      shell (Requirement: Prebuilt installer is auditable and discloses caveats — Scenario:
      Inspectable URL and manual alternative disclosed)
