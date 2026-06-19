# Changelog

## [0.8.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.7.0...v0.8.0) (2026-06-19)


### Features

* **update-check:** mirror release checks through a cache-only Cloudflare Worker ([#25](https://github.com/Xeonice/cloud-agent-platform/issues/25)) ([d9aa83b](https://github.com/Xeonice/cloud-agent-platform/commit/d9aa83b84e9c4dc842d1e167e5ac97e8e457ca7a))
* **www:** add Vercel-style marketing site with one-line installer ([#24](https://github.com/Xeonice/cloud-agent-platform/issues/24)) ([c8ad3f9](https://github.com/Xeonice/cloud-agent-platform/commit/c8ad3f9640e05903cb73b6f055af2b0ceffc678f))


### Bug Fixes

* **self-update:** ensure updater image is present before createContainer ([#22](https://github.com/Xeonice/cloud-agent-platform/issues/22)) ([fbcacb5](https://github.com/Xeonice/cloud-agent-platform/commit/fbcacb5774a8a0aac00693a78febc120d425583f))
* **www:** serve static export via framework:null so Vercel serves out/ (no routes-manifest) ([92345d3](https://github.com/Xeonice/cloud-agent-platform/commit/92345d3910b738b1772aebc77de810ded904b67e))

## [0.7.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.6.0...v0.7.0) (2026-06-18)


### Bug Fixes

* **agent-runtime:** claude-code tasks select the claude runtime ([#20](https://github.com/Xeonice/cloud-agent-platform/issues/20)) ([e611ab9](https://github.com/Xeonice/cloud-agent-platform/commit/e611ab9b708ab1b470e87c29823d6332010965ad))

## [0.6.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.5.0...v0.6.0) (2026-06-18)


### Features

* add Claude Code as a second selectable agent runtime ([#18](https://github.com/Xeonice/cloud-agent-platform/issues/18)) ([f050ab0](https://github.com/Xeonice/cloud-agent-platform/commit/f050ab02997ac5661647102d39b93caa4be5ed82))
* **web:** show terminal history as a static scrollable log, not a timed replay ([#15](https://github.com/Xeonice/cloud-agent-platform/issues/15)) ([cea5898](https://github.com/Xeonice/cloud-agent-platform/commit/cea5898bfd4977934b4743c3e0f0471c40953349))

## [0.5.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.4.1...v0.5.0) (2026-06-17)


### Features

* **settings:** wire compatible model-provider into codex execution ([#13](https://github.com/Xeonice/cloud-agent-platform/issues/13)) ([4f7fd3b](https://github.com/Xeonice/cloud-agent-platform/commit/4f7fd3b8467a6dd5203301ae561c0e204bdba3ff))

## [0.4.1](https://github.com/Xeonice/cloud-agent-platform/compare/v0.4.0...v0.4.1) (2026-06-17)


### Bug Fixes

* surface new releases promptly in the update banner ([#11](https://github.com/Xeonice/cloud-agent-platform/issues/11)) ([1b0bc55](https://github.com/Xeonice/cloud-agent-platform/commit/1b0bc5530307da35c751d605233cab2149ca9783))

## [0.4.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.3.3...v0.4.0) (2026-06-17)


### Features

* session terminal replay (asciicast recording + xterm timing player) ([#9](https://github.com/Xeonice/cloud-agent-platform/issues/9)) ([30e1213](https://github.com/Xeonice/cloud-agent-platform/commit/30e1213204df68632806b7cddff6fc8de8f4a2cb))

## [0.3.3](https://github.com/Xeonice/cloud-agent-platform/compare/v0.3.2...v0.3.3) (2026-06-17)


### Bug Fixes

* **web:** persist self-update target so a mid-upgrade refresh resumes the poll ([1eb239d](https://github.com/Xeonice/cloud-agent-platform/commit/1eb239d04001379fa1272cb10fb5502101da5aa7))

## [0.3.2](https://github.com/Xeonice/cloud-agent-platform/compare/v0.3.1...v0.3.2) (2026-06-17)


### Bug Fixes

* **web:** self-update banner polls /version for completion + auto-refreshes ([df0464a](https://github.com/Xeonice/cloud-agent-platform/commit/df0464ae252f22193c11714beaeed606ee5e290b))

## [0.3.1](https://github.com/Xeonice/cloud-agent-platform/compare/v0.3.0...v0.3.1) (2026-06-17)


### Bug Fixes

* **self-update:** bind the working-dir parent so the updater keeps env_file secrets on recreate ([b4a0a6c](https://github.com/Xeonice/cloud-agent-platform/commit/b4a0a6c87ff71ede62459b3d73576f79790e2af5))

## [0.3.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.2.1...v0.3.0) (2026-06-17)


### Features

* **web:** activate update banner + one-click self-update Upgrade action in the console ([fe58c5b](https://github.com/Xeonice/cloud-agent-platform/commit/fe58c5bc9467edcd64abadcf3b9b7b54ea12347b))

## [0.2.1](https://github.com/Xeonice/cloud-agent-platform/compare/v0.2.0...v0.2.1) (2026-06-17)


### Bug Fixes

* **self-update:** auto-detect compose topology so one-click upgrade works on the resident stack ([6b8c9ea](https://github.com/Xeonice/cloud-agent-platform/commit/6b8c9eaa352fe8cee024d64635a2c6aa0ebdd5a5))

## [0.2.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.1.0...v0.2.0) (2026-06-17)


### Features

* **deploy:** default CAP_VERSION to latest in the run package (bare up just runs the newest release) ([44857a9](https://github.com/Xeonice/cloud-agent-platform/commit/44857a9007aca8adbde274814659d62a4869ad14))
* **deploy:** self-contained docker-compose.prod.yml for single-file platforms (Dokploy) ([06a6983](https://github.com/Xeonice/cloud-agent-platform/commit/06a6983b108d088207bda735eeea2739e6316304))
* **deploy:** source-free run package (build/run split) — prebuilt-image compose + Release assets ([f1e1bf7](https://github.com/Xeonice/cloud-agent-platform/commit/f1e1bf7bee9a72b16c19d22dce61b128bb170595))
* **release:** automate version bump/tag/Release via release-please ([5a9a162](https://github.com/Xeonice/cloud-agent-platform/commit/5a9a16212038cc884912e870ff65e707ac6c7701))
* **run-package:** opt-in inline observability + resident-compose cutover ([5e606cc](https://github.com/Xeonice/cloud-agent-platform/commit/5e606cc22d85bd2cca4bc3ecc85ac4f7ffb3c0b6))
