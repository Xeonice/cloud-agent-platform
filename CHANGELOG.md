# Changelog

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
