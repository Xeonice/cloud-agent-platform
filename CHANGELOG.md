# Changelog

## [0.45.3](https://github.com/Xeonice/cloud-agent-platform/compare/v0.45.2...v0.45.3) (2026-07-24)


### Bug Fixes

* **boxlite:** resolve the daemon's nested extraction layout before part reassembly ([#177](https://github.com/Xeonice/cloud-agent-platform/issues/177)) ([378362c](https://github.com/Xeonice/cloud-agent-platform/commit/378362ce8060f4bb1d28e6b9b3085ea911ac495d))

## [0.45.2](https://github.com/Xeonice/cloud-agent-platform/compare/v0.45.1...v0.45.2) (2026-07-24)


### Bug Fixes

* **boxlite:** wrap each archive part in a single-entry tar envelope ([#176](https://github.com/Xeonice/cloud-agent-platform/issues/176)) ([34c8611](https://github.com/Xeonice/cloud-agent-platform/commit/34c8611e57992220a9b9d9634c93b209def5d97a))

## [0.45.1](https://github.com/Xeonice/cloud-agent-platform/compare/v0.45.0...v0.45.1) (2026-07-24)


### Bug Fixes

* **boxlite:** chunk archive injection under the daemon body limit and surface transfer progress ([#175](https://github.com/Xeonice/cloud-agent-platform/issues/175)) ([1d64a01](https://github.com/Xeonice/cloud-agent-platform/commit/1d64a01923e4518cad3307be95d858fcacfa5d31))
* resolve verify findings for chunk-archive-injection-with-progress ([#175](https://github.com/Xeonice/cloud-agent-platform/issues/175)) ([1dbbfbe](https://github.com/Xeonice/cloud-agent-platform/commit/1dbbfbe5bc4c5613b8f0b43c5f3419c4a33dcab5))

## [0.45.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.44.0...v0.45.0) (2026-07-23)


### Features

* acquire repo content copies at import time and inject them into sandboxes ([#173](https://github.com/Xeonice/cloud-agent-platform/issues/173)) ([7f885bb](https://github.com/Xeonice/cloud-agent-platform/commit/7f885bb684842d200d5453dfaf002902b0ba27a6))


### Bug Fixes

* wire repo deletion cascade and name the injection variant in diagnostics ([#173](https://github.com/Xeonice/cloud-agent-platform/issues/173)) ([06a1be4](https://github.com/Xeonice/cloud-agent-platform/commit/06a1be498d59366e9dcb416fcd4afb39f076fd41))

## [0.44.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.43.4...v0.44.0) (2026-07-22)


### Features

* **release:** generate task-model attestation in CI and apply it through both upgrade seams ([#171](https://github.com/Xeonice/cloud-agent-platform/issues/171)) ([55d2ebf](https://github.com/Xeonice/cloud-agent-platform/commit/55d2ebf64fbba67a4c2d7e5fc3b633330533cb53))

## [0.43.4](https://github.com/Xeonice/cloud-agent-platform/compare/v0.43.3...v0.43.4) (2026-07-21)


### Bug Fixes

* **sandbox:** relax the git low-speed abort window to 5 minutes ([329b7cc](https://github.com/Xeonice/cloud-agent-platform/commit/329b7cc5083567bbc833fe53e73422b6a144c1c6))
* **sandbox:** relax the git low-speed abort window to 5 minutes ([1fbd1cd](https://github.com/Xeonice/cloud-agent-platform/commit/1fbd1cd51b5829be0a7492b9f41c147fa1e1f6e8))

## [0.43.3](https://github.com/Xeonice/cloud-agent-platform/compare/v0.43.2...v0.43.3) (2026-07-21)


### Bug Fixes

* **sandbox:** transfer retry must wrap the detached dual-gate path, not only the inline exec ([428052a](https://github.com/Xeonice/cloud-agent-platform/commit/428052ab95d81783e582f12d74bde5968bb438be))
* **sandbox:** transfer retry must wrap the detached dual-gate path, not only the inline exec ([062284f](https://github.com/Xeonice/cloud-agent-platform/commit/062284f0d8fd11438223de171fed3ac74ced5705))

## [0.43.2](https://github.com/Xeonice/cloud-agent-platform/compare/v0.43.1...v0.43.2) (2026-07-21)


### Bug Fixes

* **sandbox:** retry transient clone failures and classify claude TUI output on real PTY bytes ([c43c321](https://github.com/Xeonice/cloud-agent-platform/commit/c43c3210b3b33f5894bb7a6b6a3192ac4d815dc5))
* **sandbox:** retry transient clone failures and classify claude TUI output on real PTY bytes ([412c5b7](https://github.com/Xeonice/cloud-agent-platform/commit/412c5b75f95ce51d1a72c2a08915839fcfd78d55))

## [0.43.1](https://github.com/Xeonice/cloud-agent-platform/compare/v0.43.0...v0.43.1) (2026-07-21)


### Bug Fixes

* **claude:** dual-path onboarding pre-seed, 2.1.207 auth-failure classification, save-time token verification ([9cf3d3d](https://github.com/Xeonice/cloud-agent-platform/commit/9cf3d3db098f0c3ffede1d4591b4168ca249b2f6))
* **claude:** dual-path onboarding pre-seed, 2.1.207 auth-failure classification, save-time token verification ([dcfe3e3](https://github.com/Xeonice/cloud-agent-platform/commit/dcfe3e34b1068d58254e72ae9f6c578a8180d573))

## [0.43.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.42.2...v0.43.0) (2026-07-20)


### Features

* **sandbox:** detach workspace clone into a supervised job with admission parking and live progress ([17fe27e](https://github.com/Xeonice/cloud-agent-platform/commit/17fe27e87654a2175ce0cd179c6ac4f2e1452331))
* **sandbox:** detach workspace clone into a supervised job with admission parking and live progress ([d1e7f73](https://github.com/Xeonice/cloud-agent-platform/commit/d1e7f73df486fccb7a39a67273f8fd24e918d5dc))

## [0.42.2](https://github.com/Xeonice/cloud-agent-platform/compare/v0.42.1...v0.42.2) (2026-07-20)


### Bug Fixes

* **self-update:** make BoxLite rootfs extraction portable across shared-mount hosts ([dc6c573](https://github.com/Xeonice/cloud-agent-platform/commit/dc6c57358da080582bec85561a3b4cefebdbbf47))
* **self-update:** make BoxLite rootfs extraction portable across shared-mount hosts ([f4d02c0](https://github.com/Xeonice/cloud-agent-platform/commit/f4d02c08f4b52f09ad1ff9f42b86649ee5bd2c1f))

## [0.42.1](https://github.com/Xeonice/cloud-agent-platform/compare/v0.42.0...v0.42.1) (2026-07-20)


### Bug Fixes

* **scripts:** isolate git env in public-surface suites so hooks cannot corrupt the repo ([0c208b3](https://github.com/Xeonice/cloud-agent-platform/commit/0c208b34f78acd505058b115d1b36da2949eea3b))
* **scripts:** isolate git env in public-surface suites so hooks cannot corrupt the repo ([917b29e](https://github.com/Xeonice/cloud-agent-platform/commit/917b29e33ae29b30649ccdb27a22f19152a1e3ef))

## [0.42.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.41.3...v0.42.0) (2026-07-20)


### Features

* edit sandbox environment image parameters after registration ([e0c8d78](https://github.com/Xeonice/cloud-agent-platform/commit/e0c8d78f4ec61f9bddadf6842188deda34ce904b))
* edit sandbox environment image parameters after registration ([5403a61](https://github.com/Xeonice/cloud-agent-platform/commit/5403a6157627eb0189b1182162c07784f069989e))

## [0.41.3](https://github.com/Xeonice/cloud-agent-platform/compare/v0.41.2...v0.41.3) (2026-07-19)


### Bug Fixes

* **api:** execute advisory locks without decoding void ([#153](https://github.com/Xeonice/cloud-agent-platform/issues/153)) ([78fc6aa](https://github.com/Xeonice/cloud-agent-platform/commit/78fc6aae2519ad5e9a1da38c6895d384d53468e6))

## [0.41.2](https://github.com/Xeonice/cloud-agent-platform/compare/v0.41.1...v0.41.2) (2026-07-19)


### Bug Fixes

* fence legacy sandbox provisioning cancellation ([ee2460d](https://github.com/Xeonice/cloud-agent-platform/commit/ee2460d2469781bab26a21d1fee3b673b3a51d45))
* fence legacy sandbox provisioning cancellation ([6711135](https://github.com/Xeonice/cloud-agent-platform/commit/6711135baa34fe560ebbf57167d470437124efba))

## [0.41.1](https://github.com/Xeonice/cloud-agent-platform/compare/v0.41.0...v0.41.1) (2026-07-19)


### Bug Fixes

* **sandbox:** require complete BoxLite command output ([#149](https://github.com/Xeonice/cloud-agent-platform/issues/149)) ([fbd8f51](https://github.com/Xeonice/cloud-agent-platform/commit/fbd8f518723ca03760363869a266132aaae260e0))

## [0.41.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.40.0...v0.41.0) (2026-07-18)


### Features

* **tasks:** add durable provisioning diagnostics ([6350cd0](https://github.com/Xeonice/cloud-agent-platform/commit/6350cd01046ce2fdd2bda175a1117e4bd0a1f983))
* **tasks:** add durable provisioning diagnostics ([38c5183](https://github.com/Xeonice/cloud-agent-platform/commit/38c51835fef9df2ed1f23845df5f5b6bc906daed))

## [0.40.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.39.1...v0.40.0) (2026-07-16)


### Features

* **repositories:** harden forge default branch resolution ([f97e7df](https://github.com/Xeonice/cloud-agent-platform/commit/f97e7dfcb771163ba136292e19c761d4ca55039a))

## [0.39.1](https://github.com/Xeonice/cloud-agent-platform/compare/v0.39.0...v0.39.1) (2026-07-16)


### Bug Fixes

* **tasks:** harden large private repository provisioning ([fe94b7a](https://github.com/Xeonice/cloud-agent-platform/commit/fe94b7a2ef59da3959b307d71fdac033e49dbeb9))
* **tasks:** harden large private repository provisioning ([995051e](https://github.com/Xeonice/cloud-agent-platform/commit/995051eb133baaf66c64168ba536c3abe5597d5a))

## [0.39.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.38.0...v0.39.0) (2026-07-14)


### Features

* **tasks:** add model selection with API and MCP parity ([a27356f](https://github.com/Xeonice/cloud-agent-platform/commit/a27356f8ea1035861d70050cc934844d3376eaad))

## [0.38.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.37.5...v0.38.0) (2026-07-13)


### Features

* **schedules:** add sub-day recurrence controls ([fe45f83](https://github.com/Xeonice/cloud-agent-platform/commit/fe45f83e3154724fa74d3efef654dd1ccebf816b))
* **schedules:** add sub-day recurrence controls ([013d262](https://github.com/Xeonice/cloud-agent-platform/commit/013d262c862ce36912c58df5d843d148b64e5099))

## [0.37.5](https://github.com/Xeonice/cloud-agent-platform/compare/v0.37.4...v0.37.5) (2026-07-13)


### Bug Fixes

* **settings:** harden Codex device login ([f0a38fc](https://github.com/Xeonice/cloud-agent-platform/commit/f0a38fcb4ce851337ac3cef792288f1bcfa8b72e))
* **settings:** harden Codex device login ([2c46efe](https://github.com/Xeonice/cloud-agent-platform/commit/2c46efedb6f0b06c2917b67f061318e74bbd17d4))

## [0.37.4](https://github.com/Xeonice/cloud-agent-platform/compare/v0.37.3...v0.37.4) (2026-07-12)


### Bug Fixes

* **deploy:** allow slow BoxLite cold starts ([21cf9fa](https://github.com/Xeonice/cloud-agent-platform/commit/21cf9fa122cfd2fed614cf311e8f2d657e852429))
* **deploy:** allow slow BoxLite cold starts ([d1fd43d](https://github.com/Xeonice/cloud-agent-platform/commit/d1fd43d4acbf1581b0bf1441ed7b5a5dd53ad3ba))

## [0.37.3](https://github.com/Xeonice/cloud-agent-platform/compare/v0.37.2...v0.37.3) (2026-07-12)


### Bug Fixes

* **tasks:** surface runtime credential failures ([0fdde47](https://github.com/Xeonice/cloud-agent-platform/commit/0fdde476b6627573eddf9add86110fd5a61edffe))
* **tasks:** surface runtime credential failures ([86a9ba3](https://github.com/Xeonice/cloud-agent-platform/commit/86a9ba382d7add80f5b2111fd41f2d1dff83b865))

## [0.37.2](https://github.com/Xeonice/cloud-agent-platform/compare/v0.37.1...v0.37.2) (2026-07-11)


### Bug Fixes

* **ci:** build web dependencies for schedule e2e ([df8408f](https://github.com/Xeonice/cloud-agent-platform/commit/df8408f36d58b9c615580464c8ffab4ee4e1e08c))
* **deploy:** rotate managed boxlite assets ([76f455c](https://github.com/Xeonice/cloud-agent-platform/commit/76f455ce691988d6e751f425f388d62d5efb2cbb))
* **schedules:** harden period dispatch and visibility ([a6adfda](https://github.com/Xeonice/cloud-agent-platform/commit/a6adfda9fc2c55aff6f50d3bc6191bad253ce058))
* **schedules:** harden period dispatch and visibility ([13fe697](https://github.com/Xeonice/cloud-agent-platform/commit/13fe697af8a823dface0bec884bb2064cd112f5e))

## [0.37.1](https://github.com/Xeonice/cloud-agent-platform/compare/v0.37.0...v0.37.1) (2026-07-11)

> [!IMPORTANT]
> API versions before v0.37.1 cannot consume split AIO Release assets. Existing
> AIO deployments explicitly using `CAP_SANDBOX_IMAGE_DELIVERY=release-assets`
> must rerun the current quick-deploy flow, or switch to registry delivery and
> recreate the API, before using in-console self-update across this boundary.
> Default AIO registry delivery and the single-file BoxLite assets are unaffected.

### Bug Fixes

* **release:** split oversized sandbox image assets ([f0fa810](https://github.com/Xeonice/cloud-agent-platform/commit/f0fa8101abb8f1a67f5bfab60ccfa02c6555fd7c))

## [0.37.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.36.1...v0.37.0) (2026-07-10)


### Features

* **sandbox:** expose sandbox toolchain versions ([161a54e](https://github.com/Xeonice/cloud-agent-platform/commit/161a54ee298266f5cda6eb3f9ac0c3f5f572c9a8))

## [0.36.1](https://github.com/Xeonice/cloud-agent-platform/compare/v0.36.0...v0.36.1) (2026-07-10)


### Bug Fixes

* **schedules:** align scheduler MCP and public API ([632429b](https://github.com/Xeonice/cloud-agent-platform/commit/632429b1e78da2b8a2d6659312d240b0ab9a549f))

## [0.36.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.35.0...v0.36.0) (2026-07-09)


### Features

* **schedules:** edit and dispatch schedules ([1ee37f0](https://github.com/Xeonice/cloud-agent-platform/commit/1ee37f050ba097df5ee135caa3f26ac4cf8ee03b))
* **schedules:** edit and dispatch schedules ([f11e473](https://github.com/Xeonice/cloud-agent-platform/commit/f11e473dcbe52285fe67cfc5a0c9247c5f679f24))

## [0.35.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.34.0...v0.35.0) (2026-07-09)


### Features

* **schedules:** simplify scheduled task creation ([de73bf7](https://github.com/Xeonice/cloud-agent-platform/commit/de73bf78f0d4ae5ddc4df4f79edddf5b65cf632c))
* **schedules:** simplify scheduled task creation ([c5e16ab](https://github.com/Xeonice/cloud-agent-platform/commit/c5e16ab547cb9cafa38d07b43882eb0cda43fec4))

## [0.34.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.33.0...v0.34.0) (2026-07-09)


### Features

* **schedules:** add scheduled task automation ([4ad6780](https://github.com/Xeonice/cloud-agent-platform/commit/4ad678001e3744262f4f32d08d9c7cfdaf406a2f))
* **schedules:** add scheduled task automation ([e25c8a4](https://github.com/Xeonice/cloud-agent-platform/commit/e25c8a48b29f75791b5f1859be24be1b2d729499))

## [0.33.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.32.2...v0.33.0) (2026-07-09)


### Features

* add sandbox image parameters ([201fce3](https://github.com/Xeonice/cloud-agent-platform/commit/201fce3998b1b662c3e9bcc635c80275d06244e7))
* add sandbox image parameters ([d36fcba](https://github.com/Xeonice/cloud-agent-platform/commit/d36fcba30a7983088cdfea41003f340c92f14d14))

## [0.32.2](https://github.com/Xeonice/cloud-agent-platform/compare/v0.32.1...v0.32.2) (2026-07-08)


### Bug Fixes

* **sandbox:** clarify admin image registration ([944e67a](https://github.com/Xeonice/cloud-agent-platform/commit/944e67aeb1e9fbdd6d2bed3b5cb63a5fcdb2b9ba))
* **sandbox:** clarify admin image registration ([93ac18f](https://github.com/Xeonice/cloud-agent-platform/commit/93ac18f6ce52b20de5d7c4792752515d6f09be2f))

## [0.32.1](https://github.com/Xeonice/cloud-agent-platform/compare/v0.32.0...v0.32.1) (2026-07-08)


### Bug Fixes

* **sandbox:** harden custom image operations ([270d2b1](https://github.com/Xeonice/cloud-agent-platform/commit/270d2b16cf0c9505e6067b9ac38672185c7ce8a2))
* **sandbox:** harden custom image operations ([9237f01](https://github.com/Xeonice/cloud-agent-platform/commit/9237f010a1ff52c337dffed25f66b369d650abe0))

## [0.32.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.31.0...v0.32.0) (2026-07-07)


### Features

* **web:** add custom sandbox image help ([f01444e](https://github.com/Xeonice/cloud-agent-platform/commit/f01444e64f6ea3f1648ffb7c3d3ec160fbc374a0))
* **web:** add custom sandbox image help ([310d902](https://github.com/Xeonice/cloud-agent-platform/commit/310d9028339fa1655e2b6e187d72ce8326d93a51))

## [0.31.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.30.0...v0.31.0) (2026-07-07)


### Features

* **sandbox:** simplify custom image sources ([61f6b52](https://github.com/Xeonice/cloud-agent-platform/commit/61f6b52020481d0d095bfff6c9045383c29ed182))
* **sandbox:** simplify custom image sources ([5a5a618](https://github.com/Xeonice/cloud-agent-platform/commit/5a5a6180803cdf68b6e29ed74f956c4cb5496a5c))

## [0.30.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.29.0...v0.30.0) (2026-07-06)


### Features

* **settings:** add user default sandbox image ([35a9c55](https://github.com/Xeonice/cloud-agent-platform/commit/35a9c552f7422ac4b7c2aaf260449b0ad4bc273e))

## [0.29.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.28.0...v0.29.0) (2026-07-06)


### Features

* **sandbox:** add managed sandbox environments ([89d3e9f](https://github.com/Xeonice/cloud-agent-platform/commit/89d3e9f5d7b69a9985c8749a7db9c2987798e0fa))
* **sandbox:** add managed sandbox environments ([08972b6](https://github.com/Xeonice/cloud-agent-platform/commit/08972b6d25698d6bb8621df53ade7048f571b8ea))

## [0.28.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.27.5...v0.28.0) (2026-07-03)


### Features

* support URL-based forge imports ([86f1359](https://github.com/Xeonice/cloud-agent-platform/commit/86f1359d125cfe4888639b5f514756bea14631e5))
* support URL-based forge imports ([16f7f96](https://github.com/Xeonice/cloud-agent-platform/commit/16f7f961dbd1ca67576b74eb8364e8fd2c786e87))

## [0.27.5](https://github.com/Xeonice/cloud-agent-platform/compare/v0.27.4...v0.27.5) (2026-07-03)


### Bug Fixes

* **terminal:** keep resize repaints out of replay history ([b0165e0](https://github.com/Xeonice/cloud-agent-platform/commit/b0165e00ecd772c8df03c051846c1f0bf09aecf6))

## [0.27.4](https://github.com/Xeonice/cloud-agent-platform/compare/v0.27.3...v0.27.4) (2026-07-02)


### Bug Fixes

* restore terminal refresh scrollback ([97e1c82](https://github.com/Xeonice/cloud-agent-platform/commit/97e1c828af27be28bcda911769d0008e6f7e2794))

## [0.27.3](https://github.com/Xeonice/cloud-agent-platform/compare/v0.27.2...v0.27.3) (2026-07-02)


### Bug Fixes

* prevent stale terminal replay after refresh ([ba13f25](https://github.com/Xeonice/cloud-agent-platform/commit/ba13f25d63d48f5583612daf158cae6fcabed411))

## [0.27.2](https://github.com/Xeonice/cloud-agent-platform/compare/v0.27.1...v0.27.2) (2026-07-01)


### Bug Fixes

* preserve terminal history across readoption ([8eb86c3](https://github.com/Xeonice/cloud-agent-platform/commit/8eb86c329dcf4916f518a213392b89604fbf5ef0))
* preserve terminal history across readoption ([713da31](https://github.com/Xeonice/cloud-agent-platform/commit/713da31668794d561ad06f895f738aaccaba3d73))

## [0.27.1](https://github.com/Xeonice/cloud-agent-platform/compare/v0.27.0...v0.27.1) (2026-07-01)


### Bug Fixes

* surface selected sandbox provider ([86a70bf](https://github.com/Xeonice/cloud-agent-platform/commit/86a70bf19a54207400cde10548ece5b63029531e))

## [0.27.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.26.0...v0.27.0) (2026-07-01)


### Features

* rework sandbox provider center ([b48f88a](https://github.com/Xeonice/cloud-agent-platform/commit/b48f88a3145fe20da71f5a3eac702a5c8d129dc8))


### Bug Fixes

* hide tmux status line in terminal attach ([738e594](https://github.com/Xeonice/cloud-agent-platform/commit/738e594ccf54c6a99c063967528895a566f029c4))
* **sandbox:** readopt persisted provider owners on startup ([deed398](https://github.com/Xeonice/cloud-agent-platform/commit/deed398496147f37dbfb7b76c4a2b8f704b262e1))

## [0.26.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.25.8...v0.26.0) (2026-06-30)


### Features

* add sandbox release assets and terminal stories ([3e86daa](https://github.com/Xeonice/cloud-agent-platform/commit/3e86daa7c7653e0c4d23312c5373ab1d2fff6e80))


### Bug Fixes

* **terminal:** preserve replay history and viewport ([09ceece](https://github.com/Xeonice/cloud-agent-platform/commit/09ceece89695962826d92034ab0551a7ecaeed5e))

## [0.25.8](https://github.com/Xeonice/cloud-agent-platform/compare/v0.25.7...v0.25.8) (2026-06-29)


### Bug Fixes

* **api:** preserve terminal utf8 and tmux geometry ([ba1ba68](https://github.com/Xeonice/cloud-agent-platform/commit/ba1ba686c6fef1682260e1f364c5edffe120352d))
* **api:** preserve terminal utf8 and tmux geometry ([be3e460](https://github.com/Xeonice/cloud-agent-platform/commit/be3e460fd907d08fff2eb2469cb54871b9acc15c))

## [0.25.7](https://github.com/Xeonice/cloud-agent-platform/compare/v0.25.6...v0.25.7) (2026-06-29)


### Bug Fixes

* **boxlite:** pass sandbox proxy env ([06c8704](https://github.com/Xeonice/cloud-agent-platform/commit/06c8704c195dbf2703c05d4880582d4b5775dea9))

## [0.25.6](https://github.com/Xeonice/cloud-agent-platform/compare/v0.25.5...v0.25.6) (2026-06-29)


### Bug Fixes

* run runtime setup in BoxLite sandboxes ([8dce371](https://github.com/Xeonice/cloud-agent-platform/commit/8dce371f4c1548ff93fd85c4d184562b2589da00))

## [0.25.5](https://github.com/Xeonice/cloud-agent-platform/compare/v0.25.4...v0.25.5) (2026-06-29)


### Bug Fixes

* **boxlite:** export terminal TERM for native pty ([f7b8705](https://github.com/Xeonice/cloud-agent-platform/commit/f7b87052bb09ad19c8f02891e0a8bcf2e667a120))

## [0.25.4](https://github.com/Xeonice/cloud-agent-platform/compare/v0.25.3...v0.25.4) (2026-06-28)


### Bug Fixes

* **boxlite:** reuse base uid for runtime image ([06640a7](https://github.com/Xeonice/cloud-agent-platform/commit/06640a7463f297f2514ecbed4970c07ed9e4ff24))

## [0.25.3](https://github.com/Xeonice/cloud-agent-platform/compare/v0.25.2...v0.25.3) (2026-06-28)


### Bug Fixes

* **boxlite:** publish official runtime image ([46d496e](https://github.com/Xeonice/cloud-agent-platform/commit/46d496e1c38f6896a3635da8c7e73851489ee8f9))

## [0.25.2](https://github.com/Xeonice/cloud-agent-platform/compare/v0.25.1...v0.25.2) (2026-06-28)


### Bug Fixes

* **boxlite:** enforce aio runtime dependency checks ([7e6fc2d](https://github.com/Xeonice/cloud-agent-platform/commit/7e6fc2da7c8e5329d1768838d6e4d99cc6ba61f5))

## [0.25.1](https://github.com/Xeonice/cloud-agent-platform/compare/v0.25.0...v0.25.1) (2026-06-28)


### Bug Fixes

* harden BoxLite release installs ([21c7911](https://github.com/Xeonice/cloud-agent-platform/commit/21c7911ae6410a6f711e6db917034392bd76c986))

## [0.25.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.24.2...v0.25.0) (2026-06-27)


### Features

* support runtime same-host web endpoints ([bdd2d5d](https://github.com/Xeonice/cloud-agent-platform/commit/bdd2d5d36d972cf98b56a15ce36dea87256515e9))

## [0.24.2](https://github.com/Xeonice/cloud-agent-platform/compare/v0.24.1...v0.24.2) (2026-06-27)


### Bug Fixes

* use local account quick deploy auth ([dbda5ab](https://github.com/Xeonice/cloud-agent-platform/commit/dbda5ab30588c13081e9a43cce419cdaca4a42ba))

## [0.24.1](https://github.com/Xeonice/cloud-agent-platform/compare/v0.24.0...v0.24.1) (2026-06-27)


### Bug Fixes

* use release images for one-line installer ([ed4d3c9](https://github.com/Xeonice/cloud-agent-platform/commit/ed4d3c95fe144c0301e3fa194d575b8e7537353f))

## [0.24.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.23.4...v0.24.0) (2026-06-26)


### Features

* **sandbox:** add BoxLite provider and platform startup defaults ([f0abb79](https://github.com/Xeonice/cloud-agent-platform/commit/f0abb795ce3a30470b2ba35506bb78b6bc7df572))

## [0.23.4](https://github.com/Xeonice/cloud-agent-platform/compare/v0.23.3...v0.23.4) (2026-06-26)


### Bug Fixes

* **web:** render markdown in session replay ([684aeb7](https://github.com/Xeonice/cloud-agent-platform/commit/684aeb70a58a8ccff9da06347d3a248fe0c4875f))

## [0.23.3](https://github.com/Xeonice/cloud-agent-platform/compare/v0.23.2...v0.23.3) (2026-06-26)


### Bug Fixes

* **auth:** release PAT-only repository import ([81a89e9](https://github.com/Xeonice/cloud-agent-platform/commit/81a89e9eeef4d73252e7cfb34a8e7b7c14fdc8d4))

## [0.23.2](https://github.com/Xeonice/cloud-agent-platform/compare/v0.23.1...v0.23.2) (2026-06-25)


### Bug Fixes

* enable yolo agent launch ([6772a11](https://github.com/Xeonice/cloud-agent-platform/commit/6772a11d7fda51406dafadd89d663d03926b3873))

## [0.23.1](https://github.com/Xeonice/cloud-agent-platform/compare/v0.23.0...v0.23.1) (2026-06-25)


### Bug Fixes

* stabilize live terminal replay and input ([6b9c624](https://github.com/Xeonice/cloud-agent-platform/commit/6b9c624ea205f1af0423a278f71531907c644e31))

## [0.23.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.22.0...v0.23.0) (2026-06-25)


### Features

* surface a Claude Code one-click deploy path ([cc56e6f](https://github.com/Xeonice/cloud-agent-platform/commit/cc56e6f5b09983a1bc40b871f74ac969ecb5157e))
* surface a Claude Code one-click deploy path ([47082c1](https://github.com/Xeonice/cloud-agent-platform/commit/47082c113f68f553dcfc9f998cfb4c6633d3ee47))

## [0.22.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.21.0...v0.22.0) (2026-06-25)


### Features

* **deploy:** agent one-click prebuilt-image self-host (no OAuth) ([#62](https://github.com/Xeonice/cloud-agent-platform/issues/62)) ([ecad5a3](https://github.com/Xeonice/cloud-agent-platform/commit/ecad5a39e8ab8f3c9c66291cace2aeb52294b078))
* **www:** surface quick-deploy.sh as a site-hosted one-liner ([#62](https://github.com/Xeonice/cloud-agent-platform/issues/62)) ([4e815d4](https://github.com/Xeonice/cloud-agent-platform/commit/4e815d4e804f0c997c87e2c58910b3100c90229b))


## [0.21.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.20.7...v0.21.0) (2026-06-24)


### Features

* **console:** render headless tasks as a live conversation, not a JSON terminal ([#61](https://github.com/Xeonice/cloud-agent-platform/issues/61)) ([0c48dbc](https://github.com/Xeonice/cloud-agent-platform/commit/0c48dbc74a252a4b878c44f20356cc6bed26f7a3))


## [0.20.7](https://github.com/Xeonice/cloud-agent-platform/compare/v0.20.6...v0.20.7) (2026-06-24)


### Bug Fixes

* **terminal:** strip alt-screen on snapshot/tail_replay too (v0.20.6 only did onRaw) ([#60](https://github.com/Xeonice/cloud-agent-platform/issues/60)) ([4221e6c](https://github.com/Xeonice/cloud-agent-platform/commit/4221e6c))


## [0.20.6](https://github.com/Xeonice/cloud-agent-platform/compare/v0.20.5...v0.20.6) (2026-06-24)


### Bug Fixes

* **terminal:** strip alt-screen from the live stream for scrollback (tmux-off A reverted) ([#59](https://github.com/Xeonice/cloud-agent-platform/issues/59)) ([42d2958](https://github.com/Xeonice/cloud-agent-platform/commit/42d295897544f79e70529d2d9884cd7312fe0155))


## [0.20.5](https://github.com/Xeonice/cloud-agent-platform/compare/v0.20.4...v0.20.5) (2026-06-24)


### Bug Fixes

* **terminal:** scroll back the running live terminal (tmux alt-screen off + viewport sync) ([#58](https://github.com/Xeonice/cloud-agent-platform/issues/58)) ([ebcfb03](https://github.com/Xeonice/cloud-agent-platform/commit/ebcfb03e5981c394e95010042b84fd770e27f1c4))


## [0.20.4](https://github.com/Xeonice/cloud-agent-platform/compare/v0.20.3...v0.20.4) (2026-06-24)


### Bug Fixes

* **terminal:** sync terminal-record viewport scroll-area after paced fill ([#57](https://github.com/Xeonice/cloud-agent-platform/issues/57)) ([d2b8850](https://github.com/Xeonice/cloud-agent-platform/commit/d2b88504af90bf244c7b3b0a37b03dca4da5130b))


## [0.20.3](https://github.com/Xeonice/cloud-agent-platform/compare/v0.20.2...v0.20.3) (2026-06-24)


### Bug Fixes

* **terminal:** backpressure terminal-record replay so large casts don't discard data ([#56](https://github.com/Xeonice/cloud-agent-platform/issues/56)) ([3e31954](https://github.com/Xeonice/cloud-agent-platform/commit/3e31954fb5277a22e2d72abe80b78e9c73a4ae11))


## [0.20.2](https://github.com/Xeonice/cloud-agent-platform/compare/v0.20.1...v0.20.2) (2026-06-23)


### Bug Fixes

* **terminal:** recover wide-screen xterm fallback + codex inline scrollback ([#55](https://github.com/Xeonice/cloud-agent-platform/issues/55)) ([ccc85a8](https://github.com/Xeonice/cloud-agent-platform/commit/ccc85a86f8d14e0903f006ea8942d69087150ffc))


## [0.20.1](https://github.com/Xeonice/cloud-agent-platform/compare/v0.20.0...v0.20.1) (2026-06-23)


### Bug Fixes

* **rate-limit:** scope the create tier to POST /v1/tasks only ([#54](https://github.com/Xeonice/cloud-agent-platform/issues/54)) ([64a544c](https://github.com/Xeonice/cloud-agent-platform/commit/64a544caf7a47f5c4a03c879aa511282351e4562))
* **settings:** scope api-key/mcp-token/codex/import by account id for local accounts ([#54](https://github.com/Xeonice/cloud-agent-platform/issues/54)) ([11f2e13](https://github.com/Xeonice/cloud-agent-platform/commit/11f2e13b8554872959d234903d3fda22fa3ab82c))


### Chores

* **deploy:** scriptize release + upgrade (force both images together) ([#54](https://github.com/Xeonice/cloud-agent-platform/issues/54)) ([9605016](https://github.com/Xeonice/cloud-agent-platform/commit/960501688befdb6020ee6b2752f033e5dfc3827e))


## [0.20.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.19.0...v0.20.0) (2026-06-23)


### Features

* **console:** OTP login send feedback + 60s resend countdown ([#53](https://github.com/Xeonice/cloud-agent-platform/issues/53)) ([f1ace76](https://github.com/Xeonice/cloud-agent-platform/commit/f1ace76a8e1fbfb743e39d68700390918d8679be))


### Bug Fixes

* **settings:** scope per-account settings by account id, not GitHub identity ([#53](https://github.com/Xeonice/cloud-agent-platform/issues/53)) ([c701b4f](https://github.com/Xeonice/cloud-agent-platform/commit/c701b4f204d8ca13813c6ec8e088ec2b6c51a856))


## [0.19.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.18.1...v0.19.0) (2026-06-23)


### Features

* **settings:** admin-configurable Resend SMTP in the console ([#52](https://github.com/Xeonice/cloud-agent-platform/issues/52)) ([302b3b9](https://github.com/Xeonice/cloud-agent-platform/commit/302b3b96c58688ab23eecb14e7ad4685dedf0db8))


## [0.18.1](https://github.com/Xeonice/cloud-agent-platform/compare/v0.18.0...v0.18.1) (2026-06-23)


### Bug Fixes

* **auth:** promote an existing ADMIN_EMAIL account to admin ([#51](https://github.com/Xeonice/cloud-agent-platform/issues/51)) ([c342cdf](https://github.com/Xeonice/cloud-agent-platform/commit/c342cdf6136d1551b8d32b53bb9c4436611b8a26))


## [0.18.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.17.0...v0.18.0) (2026-06-23)


### Features

* **mail:** branded HTML OTP email template ([#50](https://github.com/Xeonice/cloud-agent-platform/issues/50)) ([e03596a](https://github.com/Xeonice/cloud-agent-platform/commit/e03596a2dac1d01537b18511eaf890aff88c6537))


## [0.17.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.16.0...v0.17.0) (2026-06-22)


### Features

* **mail:** recipient-routed transport seam + Resend OTP delivery docs ([#48](https://github.com/Xeonice/cloud-agent-platform/issues/48)) ([a245cc4](https://github.com/Xeonice/cloud-agent-platform/commit/a245cc48bbad5c2e213a8dd15386bbbf80011764))


### Bug Fixes

* **auth:** full-page post-login navigation + rotate session on password change ([#48](https://github.com/Xeonice/cloud-agent-platform/issues/48)) ([0981782](https://github.com/Xeonice/cloud-agent-platform/commit/09817820d99775f381eef2b71670fa2bc41d84c1))


## [0.16.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.15.1...v0.16.0) (2026-06-22)


### Features

* **auth:** private-account identity layer — email+password, OTP, GitHub login ([#47](https://github.com/Xeonice/cloud-agent-platform/issues/47)) ([0bc4dbf](https://github.com/Xeonice/cloud-agent-platform/commit/0bc4dbf501b6b3720efa8d64509437e0b0c2d48e))


### Bug Fixes

* **console:** render transcript turn text as hardened GFM markdown ([#47](https://github.com/Xeonice/cloud-agent-platform/issues/47)) ([07e2ab8](https://github.com/Xeonice/cloud-agent-platform/commit/07e2ab8603ef211e9031076a10069b42d80806da))


## [0.15.1](https://github.com/Xeonice/cloud-agent-platform/compare/v0.15.0...v0.15.1) (2026-06-22)


### Bug Fixes

* **transcript:** unify parsers behind a registry + fix codex/claude extraction ([#45](https://github.com/Xeonice/cloud-agent-platform/issues/45)) ([3967ff4](https://github.com/Xeonice/cloud-agent-platform/commit/3967ff4ee99f20027604ba0f9c275c07ee52b789))


## [0.15.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.14.1...v0.15.0) (2026-06-22)


### Features

* **console:** render the session transcript page from real data ([#43](https://github.com/Xeonice/cloud-agent-platform/issues/43)) ([171a66e](https://github.com/Xeonice/cloud-agent-platform/commit/171a66e296889fd02e393fa04f60adad85e25e55))


### Bug Fixes

* **self-update:** pull pull-only cap images (sandbox stager) on upgrade ([#43](https://github.com/Xeonice/cloud-agent-platform/issues/43)) ([1e6ea96](https://github.com/Xeonice/cloud-agent-platform/commit/1e6ea961b70cd39b63442080c276f6086580afc5))


## [0.14.1](https://github.com/Xeonice/cloud-agent-platform/compare/v0.14.0...v0.14.1) (2026-06-22)


### Bug Fixes

* **settings:** make the forge-token help links visibly clickable ([#41](https://github.com/Xeonice/cloud-agent-platform/issues/41)) ([c79ee43](https://github.com/Xeonice/cloud-agent-platform/commit/c79ee4330f77c13ecdfbe534f41a9d2bf39d79be))


## [0.14.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.13.1...v0.14.0) (2026-06-21)


### Features

* **console:** add the forge-token help page ([#39](https://github.com/Xeonice/cloud-agent-platform/issues/39)) ([868fb6c](https://github.com/Xeonice/cloud-agent-platform/commit/868fb6ce495279db8436bdc6f441353071db8d9f))


## [0.13.1](https://github.com/Xeonice/cloud-agent-platform/compare/v0.13.0...v0.13.1) (2026-06-21)


### Bug Fixes

* **settings:** add the code-hosting connection card to the console ([#37](https://github.com/Xeonice/cloud-agent-platform/issues/37)) ([55b8b0d](https://github.com/Xeonice/cloud-agent-platform/commit/55b8b0d541f7eece5da7131da702215461fb1849))


## [0.13.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.12.2...v0.13.0) (2026-06-21)


### Features

* **settings:** forge credential connect for github/gitlab/gitee ([#36](https://github.com/Xeonice/cloud-agent-platform/issues/36)) ([d628412](https://github.com/Xeonice/cloud-agent-platform/commit/d62841204df6411cc9c30d6d77f2890198e04a32))
* **api:** land completed-task edits back to the forge as a PR/MR ([#36](https://github.com/Xeonice/cloud-agent-platform/issues/36)) ([1d92c13](https://github.com/Xeonice/cloud-agent-platform/commit/1d92c13e0d6148ded7381a8a323121f33f1eb84c))


## [0.12.2](https://github.com/Xeonice/cloud-agent-platform/compare/v0.12.1...v0.12.2) (2026-06-21)


### Bug Fixes

* **agent-runtime:** authenticate codex headless with the ChatGPT subscription ([#35](https://github.com/Xeonice/cloud-agent-platform/issues/35)) ([da45d88](https://github.com/Xeonice/cloud-agent-platform/commit/da45d88775e1b870fe492c6b59c289a6812bf218))


## [0.12.1](https://github.com/Xeonice/cloud-agent-platform/compare/v0.12.0...v0.12.1) (2026-06-21)


### Bug Fixes

* **agent-runtime:** correct codex headless argv and capture the detached exit code ([#34](https://github.com/Xeonice/cloud-agent-platform/issues/34)) ([41f4551](https://github.com/Xeonice/cloud-agent-platform/commit/41f4551cc3cb3b50c2014aab2928592a235abff0))


## [0.12.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.11.0...v0.12.0) (2026-06-20)


### Features

* **agent-runtime:** add headless execution track for programmatic consumers ([#33](https://github.com/Xeonice/cloud-agent-platform/issues/33)) ([b524042](https://github.com/Xeonice/cloud-agent-platform/commit/b524042865e6bcd44923487cd760bfff3c650142))


## [0.11.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.10.0...v0.11.0) (2026-06-20)


### Features

* **agent-runtime:** run claude-code as a resident continuous-conversation session ([#31](https://github.com/Xeonice/cloud-agent-platform/issues/31)) ([634b7e8](https://github.com/Xeonice/cloud-agent-platform/commit/634b7e847982bac362e8e238b99fc50f73acbecc))


### Bug Fixes

* **mcp:** return 405 for stateless GET/DELETE so real MCP clients connect ([#31](https://github.com/Xeonice/cloud-agent-platform/issues/31)) ([82b24c1](https://github.com/Xeonice/cloud-agent-platform/commit/82b24c19bbe75c2bec09b661be0cc8ab966e208a))
* **www:** annotate LocaleLayout return type so the static build typechecks ([#31](https://github.com/Xeonice/cloud-agent-platform/issues/31)) ([3a25fe7](https://github.com/Xeonice/cloud-agent-platform/commit/3a25fe71e822ee9f410fe6fe5d6984f0be1fabc2))


## [0.10.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.9.0...v0.10.0) (2026-06-19)


### Features

* **mcp:** activate remote MCP server + add www MCP-connect section ([b274256](https://github.com/Xeonice/cloud-agent-platform/commit/b274256e4df40643b1244ed7682325a7ae29cac9))


### Bug Fixes

* **agent-runtime:** seed Claude onboarding config at $HOME/.claude.json ([651d3bc](https://github.com/Xeonice/cloud-agent-platform/commit/651d3bc4f7d523fc6ed118299b375a657a1a6091))
* **agent-runtime:** seed Claude onboarding config at $HOME/.claude.json ([a224caa](https://github.com/Xeonice/cloud-agent-platform/commit/a224caaa7fbc329128edee1ffb3bad97973cb53d))
* **console:** reflect real agent runtime in session tag rail, drop unbacked arch chip ([5eae8b0](https://github.com/Xeonice/cloud-agent-platform/commit/5eae8b0dff669122eccddc80bb5ca85ba8c450db))

## [0.9.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.8.0...v0.9.0) (2026-06-19)


### Features

* **console:** design-baseline restore + Claude Code credential, public /v1 API, playground, MCP & API keys ([#27](https://github.com/Xeonice/cloud-agent-platform/issues/27)) ([de50b2f](https://github.com/Xeonice/cloud-agent-platform/commit/de50b2fb27e81839cc75f9d4a32c26229734f207))

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
