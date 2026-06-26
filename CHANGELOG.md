# Changelog

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
