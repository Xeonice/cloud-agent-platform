# Changelog

## [0.7.0](https://github.com/Xeonice/cloud-agent-platform/compare/v0.13.0...v0.7.0) (2026-06-21)


### Features

* add Claude Code as a second selectable agent runtime ([#18](https://github.com/Xeonice/cloud-agent-platform/issues/18)) ([f050ab0](https://github.com/Xeonice/cloud-agent-platform/commit/f050ab02997ac5661647102d39b93caa4be5ed82))
* agent-control-platform — backend-first cloud agent control plane ([9f50545](https://github.com/Xeonice/cloud-agent-platform/commit/9f50545440d29080696a7a4d8a8740d7a0a65b92))
* **agent-runtime:** add headless execution track for programmatic consumers ([b524042](https://github.com/Xeonice/cloud-agent-platform/commit/b524042865e6bcd44923487cd760bfff3c650142))
* **agent-runtime:** run claude-code as a resident continuous-conversation session ([634b7e8](https://github.com/Xeonice/cloud-agent-platform/commit/634b7e847982bac362e8e238b99fc50f73acbecc))
* **aio:** auto-inject task prompt into codex + zero-touch submit ([2188d4b](https://github.com/Xeonice/cloud-agent-platform/commit/2188d4bd2442f576820b57e9229a14a0924301db))
* **aio:** close execution gaps — slim image, e2e guards, honest docs + slot-leak fix ([0d7257d](https://github.com/Xeonice/cloud-agent-platform/commit/0d7257d8c2d14f8bb11779a271826a9c910cbb50))
* **aio:** connect-in AIO Sandbox execution layer + harden 11 verified defects ([f0e8fd7](https://github.com/Xeonice/cloud-agent-platform/commit/f0e8fd78561770097839148fa83eaf35361d75e2))
* **aio:** connect-in AIO Sandbox execution layer + harden 11 verified defects ([31b6f3f](https://github.com/Xeonice/cloud-agent-platform/commit/31b6f3fa53ed9af526440032c6ae0f665ecfe9eb))
* **aio:** wire codex auth injection + per-task repo + launchCodex (close execution loop) ([173ee3a](https://github.com/Xeonice/cloud-agent-platform/commit/173ee3a4b6df90b813e61d90b75a709b50461c96))
* **api:** land completed-task edits back to the forge as a PR/MR ([1d92c13](https://github.com/Xeonice/cloud-agent-platform/commit/1d92c13e0d6148ded7381a8a323121f33f1eb84c))
* **audit:** record a diagnosable cause on task failure ([7807f2b](https://github.com/Xeonice/cloud-agent-platform/commit/7807f2bc624e7ff993fd7f4a41c3c785f23d0c82))
* **auth:** cross-origin OAuth e2e — redirect/cookie/SSR fixes + all capabilities real ([e0a40cb](https://github.com/Xeonice/cloud-agent-platform/commit/e0a40cb60021f15502d907c9317e61ad9b0bac30))
* **auth:** login→dashboard with deep-link, logout→landing, session-aware landing ([0223018](https://github.com/Xeonice/cloud-agent-platform/commit/02230187e224a8c1f034d4312b80e09029b0baf1))
* **console:** design-baseline restore + Claude Code credential, public /v1 API, playground, MCP & API keys ([#27](https://github.com/Xeonice/cloud-agent-platform/issues/27)) ([de50b2f](https://github.com/Xeonice/cloud-agent-platform/commit/de50b2fb27e81839cc75f9d4a32c26229734f207))
* **console:** make the live terminal a 1:1 surface — drop the command box ([a215f92](https://github.com/Xeonice/cloud-agent-platform/commit/a215f921a719e739e3118b3431679ec29b0f6a03))
* **console:** per-task CPU/memory on the session page + create→navigate ([b40a483](https://github.com/Xeonice/cloud-agent-platform/commit/b40a483c034e3a157be02f362ac556d2acf0976d))
* **console:** pixel-merge design revision across all pages + /metrics per-task samples ([eef0e9b](https://github.com/Xeonice/cloud-agent-platform/commit/eef0e9be0084823da0a4d0d09db8ef2ba1ae287a))
* **console:** rebuild on TanStack Start + multi-user GitHub OAuth (rebuild-console-tanstack-start) ([dbe6990](https://github.com/Xeonice/cloud-agent-platform/commit/dbe6990cba7cc1a242174638aee6bbcbdf360f53))
* **console:** rebuild web console on TanStack Start + multi-user OAuth backend ([b2039f9](https://github.com/Xeonice/cloud-agent-platform/commit/b2039f90be2f43ce3bfd4a97c437b2376793989e))
* **console:** session-page cockpit redesign (Geist) + sidebar accent ([4770941](https://github.com/Xeonice/cloud-agent-platform/commit/47709415d689ab0f855089a5c4dd714e0e1eefc3))
* **console:** unify dialogs to fixed-width, height-capped, scrolling shell ([72fbc64](https://github.com/Xeonice/cloud-agent-platform/commit/72fbc6469ae5e178a711ba8df9f6f05b8c569732))
* **deploy:** default CAP_VERSION to latest in the run package (bare up just runs the newest release) ([44857a9](https://github.com/Xeonice/cloud-agent-platform/commit/44857a9007aca8adbde274814659d62a4869ad14))
* **deploy:** self-contained docker-compose.prod.yml for single-file platforms (Dokploy) ([06a6983](https://github.com/Xeonice/cloud-agent-platform/commit/06a6983b108d088207bda735eeea2739e6316304))
* **deploy:** source-free run package (build/run split) — prebuilt-image compose + Release assets ([f1e1bf7](https://github.com/Xeonice/cloud-agent-platform/commit/f1e1bf7bee9a72b16c19d22dce61b128bb170595))
* **dev:** one-command local stack bring-up (make up) ([f0e21f8](https://github.com/Xeonice/cloud-agent-platform/commit/f0e21f8d0b89e9c49b766812351ac3f82a994567))
* **guardrails:** opt-in idle reclaim + manual stop + exit-driven slot release ([3f36793](https://github.com/Xeonice/cloud-agent-platform/commit/3f36793970ceccd7d4b3e8c851c195bbfc41532b))
* **mcp:** activate remote MCP server + add www MCP-connect section ([b274256](https://github.com/Xeonice/cloud-agent-platform/commit/b274256e4df40643b1244ed7682325a7ae29cac9))
* **metrics:** per-task codex process sampling + carry-forward (fix not-running flicker) ([ef0b04b](https://github.com/Xeonice/cloud-agent-platform/commit/ef0b04bcaf9b5ac33f35741902aee5680dc540b8))
* **observability:** structured pino logging + opt-in Loki/Grafana stack ([14c19f0](https://github.com/Xeonice/cloud-agent-platform/commit/14c19f012c0e90bddd482fd6b2210e1feddee7b9))
* **release:** /version self-reporting + GHCR release CI + prebuilt-image path (epic Phase 1) ([4cc6f42](https://github.com/Xeonice/cloud-agent-platform/commit/4cc6f42d3502b730a34c7c7bd40c949d72542f64))
* **release:** automate version bump/tag/Release via release-please ([5a9a162](https://github.com/Xeonice/cloud-agent-platform/commit/5a9a16212038cc884912e870ff65e707ac6c7701))
* **run-package:** opt-in inline observability + resident-compose cutover ([5e606cc](https://github.com/Xeonice/cloud-agent-platform/commit/5e606cc22d85bd2cca4bc3ecc85ac4f7ffb3c0b6))
* **sandbox:** survive api redeploy via detached-tmux codex + boot re-adoption ([03c24a2](https://github.com/Xeonice/cloud-agent-platform/commit/03c24a295e4be5a75868bbd523b7de7780cf54d6))
* **self-update:** gated one-click upgrade button + bounded detached updater (epic Phase 3) ([4894d5b](https://github.com/Xeonice/cloud-agent-platform/commit/4894d5b35659508637fc9edc4d00949773dc3cfe))
* **selfhost:** ship the frontend in compose + env-configurable OAuth-first self-host (epic Phase 0) ([a7894d7](https://github.com/Xeonice/cloud-agent-platform/commit/a7894d7a64acba2f46b21561a46f5ba5205f75c8))
* session terminal replay (asciicast recording + xterm timing player) ([#9](https://github.com/Xeonice/cloud-agent-platform/issues/9)) ([30e1213](https://github.com/Xeonice/cloud-agent-platform/commit/30e1213204df68632806b7cddff6fc8de8f4a2cb))
* **session:** persist codex transcripts durably + durable-first session-history ([22cab63](https://github.com/Xeonice/cloud-agent-platform/commit/22cab6354c267c991a3cdaecf22e919aac1aed15))
* **session:** retain finished-task sandboxes + read-only conversation replay ([3e22381](https://github.com/Xeonice/cloud-agent-platform/commit/3e22381e7cd5c729eea8d969f0e4d2435edbaa0c))
* **settings,aio:** wire the Codex credential from Settings → sandbox (official ChatGPT login) ([b56af60](https://github.com/Xeonice/cloud-agent-platform/commit/b56af603cb9e24f72c297e5f03530277fe7c475d))
* **settings:** connect official Codex via OAuth device-code flow (codex login --device-auth) ([17d065a](https://github.com/Xeonice/cloud-agent-platform/commit/17d065a32dc76ac2cd866f12d37cc14c21fa7387))
* **settings:** forge credential connect for github/gitlab/gitee ([d628412](https://github.com/Xeonice/cloud-agent-platform/commit/d62841204df6411cc9c30d6d77f2890198e04a32))
* **settings:** wire compatible model-provider into codex execution ([#13](https://github.com/Xeonice/cloud-agent-platform/issues/13)) ([4f7fd3b](https://github.com/Xeonice/cloud-agent-platform/commit/4f7fd3b8467a6dd5203301ae561c0e204bdba3ff))
* **slots:** user-configurable task slot ceiling + queued-task restart recovery ([cd9a440](https://github.com/Xeonice/cloud-agent-platform/commit/cd9a440aa43ac85d83838fa1d6363d6898844860))
* **tasks:** preinstall selectable skills (openspec/bmad) into the sandbox ([e8f971f](https://github.com/Xeonice/cloud-agent-platform/commit/e8f971f611f950d992c511c83acbb59168032370))
* **update-check:** mirror release checks through a cache-only Cloudflare Worker ([#25](https://github.com/Xeonice/cloud-agent-platform/issues/25)) ([d9aa83b](https://github.com/Xeonice/cloud-agent-platform/commit/d9aa83b84e9c4dc842d1e167e5ac97e8e457ca7a))
* **update-check:** server-side update-status + dismissible console banner (epic Phase 2) ([f780bbd](https://github.com/Xeonice/cloud-agent-platform/commit/f780bbd1faab138fb32f11e0afc65652921bb36b))
* **web:** activate update banner + one-click self-update Upgrade action in the console ([fe58c5b](https://github.com/Xeonice/cloud-agent-platform/commit/fe58c5bc9467edcd64abadcf3b9b7b54ea12347b))
* **web:** show terminal history as a static scrollable log, not a timed replay ([#15](https://github.com/Xeonice/cloud-agent-platform/issues/15)) ([cea5898](https://github.com/Xeonice/cloud-agent-platform/commit/cea5898bfd4977934b4743c3e0f0471c40953349))
* **www:** add Vercel-style marketing site with one-line installer ([#24](https://github.com/Xeonice/cloud-agent-platform/issues/24)) ([c8ad3f9](https://github.com/Xeonice/cloud-agent-platform/commit/c8ad3f9640e05903cb73b6f055af2b0ceffc678f))


### Bug Fixes

* **agent-runtime:** authenticate codex headless with the ChatGPT subscription ([da45d88](https://github.com/Xeonice/cloud-agent-platform/commit/da45d88775e1b870fe492c6b59c289a6812bf218))
* **agent-runtime:** claude-code tasks select the claude runtime ([#20](https://github.com/Xeonice/cloud-agent-platform/issues/20)) ([e611ab9](https://github.com/Xeonice/cloud-agent-platform/commit/e611ab9b708ab1b470e87c29823d6332010965ad))
* **agent-runtime:** correct codex headless argv and capture the detached exit code ([41f4551](https://github.com/Xeonice/cloud-agent-platform/commit/41f4551cc3cb3b50c2014aab2928592a235abff0))
* **agent-runtime:** seed Claude onboarding config at $HOME/.claude.json ([651d3bc](https://github.com/Xeonice/cloud-agent-platform/commit/651d3bc4f7d523fc6ed118299b375a657a1a6091))
* **agent-runtime:** seed Claude onboarding config at $HOME/.claude.json ([a224caa](https://github.com/Xeonice/cloud-agent-platform/commit/a224caaa7fbc329128edee1ffb3bad97973cb53d))
* **aio,web:** close the web execution loop (ws cookie auth, codex 0.131 launch, task-context real data, dialog select) ([f0ab548](https://github.com/Xeonice/cloud-agent-platform/commit/f0ab548a280ee8520763f6f104014885735550d3))
* **aio,web:** operator write-lease wiring + drop codex 0.131 hooks-review block ([d739de8](https://github.com/Xeonice/cloud-agent-platform/commit/d739de8785d18da870ac4a103331bf8f8a697da6))
* **aio:** bake the openspec CLI so preinstalled OpenSpec skills can run ([062335e](https://github.com/Xeonice/cloud-agent-platform/commit/062335e0787a529eb6b685f3479c98df1349f42d))
* **aio:** parse exit_code from AIO /v1/shell/exec data envelope (unblocks auth-inject + clone) ([e53739f](https://github.com/Xeonice/cloud-agent-platform/commit/e53739f027cc0f88211bc4c38e5607e2ec138b61))
* **api:** reclaim orphaned sandboxes + stranded tasks on startup ([0f62608](https://github.com/Xeonice/cloud-agent-platform/commit/0f62608f0352bdbce59247344a3ceb3a5d67ef2d))
* **auth:** gate direct-load/refresh/deep-link via server-side session resolution ([4ed76a9](https://github.com/Xeonice/cloud-agent-platform/commit/4ed76a936e3858e5afb3c175a9c50d99174f4772))
* **auth:** purge stale host-only session-cookie shadow that 401'd all logged-in client calls ([b92aeb2](https://github.com/Xeonice/cloud-agent-platform/commit/b92aeb2cf7306e8fe84f58e38fe5411f13c57c26))
* **auth:** support cross-subdomain session cookie via SESSION_COOKIE_DOMAIN ([f0bf935](https://github.com/Xeonice/cloud-agent-platform/commit/f0bf935419afd6fbcbe13dc8d774d56fe33450ad))
* **console:** align real.ts api paths with backend routes + compose env_file + eslint ignores ([eef5ae8](https://github.com/Xeonice/cloud-agent-platform/commit/eef5ae840d8566016234d68f241bb91cf6cdec1d))
* **console:** close the new-task dialog before navigating to the session ([e75a386](https://github.com/Xeonice/cloud-agent-platform/commit/e75a386898ef43bd037e8a6d6ec817f3ec8a158e))
* **console:** new-task dialog pinned footer action bar + stop column stretch ([7ceb16a](https://github.com/Xeonice/cloud-agent-platform/commit/7ceb16a3834a432faf271272042ed2bdcb952525))
* **console:** reflect real agent runtime in session tag rail, drop unbacked arch chip ([5eae8b0](https://github.com/Xeonice/cloud-agent-platform/commit/5eae8b0dff669122eccddc80bb5ca85ba8c450db))
* **hooks:** delegate lint-staged to Turbo instead of root eslint (ENOENT) ([b24f88c](https://github.com/Xeonice/cloud-agent-platform/commit/b24f88c40ef96dd25b2f8e41c9a4b8f11379af11))
* **mcp:** return 405 for stateless GET/DELETE so real MCP clients connect ([82b24c1](https://github.com/Xeonice/cloud-agent-platform/commit/82b24c19bbe75c2bec09b661be0cc8ab966e208a))
* **sandbox:** make boot re-adoption scan order-independent (fix redeploy split-brain) ([042c8ea](https://github.com/Xeonice/cloud-agent-platform/commit/042c8eacc93be903ddcb5b2b6af73161af3db08a))
* **self-update:** auto-detect compose topology so one-click upgrade works on the resident stack ([6b8c9ea](https://github.com/Xeonice/cloud-agent-platform/commit/6b8c9eaa352fe8cee024d64635a2c6aa0ebdd5a5))
* **self-update:** bind the working-dir parent so the updater keeps env_file secrets on recreate ([b4a0a6c](https://github.com/Xeonice/cloud-agent-platform/commit/b4a0a6c87ff71ede62459b3d73576f79790e2af5))
* **self-update:** ensure updater image is present before createContainer ([#22](https://github.com/Xeonice/cloud-agent-platform/issues/22)) ([fbcacb5](https://github.com/Xeonice/cloud-agent-platform/commit/fbcacb5774a8a0aac00693a78febc120d425583f))
* **session:** fill live terminal to viewport height + remove page scrollbar ([dfb4bb8](https://github.com/Xeonice/cloud-agent-platform/commit/dfb4bb8fe1a221a79f55c6cd09273791f3f02850))
* **session:** move SessionTranscriptService workspace resolver off the constructor ([2fb16b8](https://github.com/Xeonice/cloud-agent-platform/commit/2fb16b80b6831fdd137e5d73ac95d4fba4a0d3aa))
* **settings:** open the device-auth verification tab synchronously so it isn't popup-blocked ([bde175f](https://github.com/Xeonice/cloud-agent-platform/commit/bde175fc5b7a9edd6978b8c71f7bb98b4eb30a48))
* surface new releases promptly in the update banner ([#11](https://github.com/Xeonice/cloud-agent-platform/issues/11)) ([1b0bc55](https://github.com/Xeonice/cloud-agent-platform/commit/1b0bc5530307da35c751d605233cab2149ca9783))
* **terminal:** sync sandbox PTY size to the browser on connect ([34b0dc9](https://github.com/Xeonice/cloud-agent-platform/commit/34b0dc9a98ecf6109a025cddef431c6d3e971b1c))
* **web,aio:** make operator-driven codex loop usable — seize-on-interact lease, CR submit, idle keepalive while attended ([d6043f7](https://github.com/Xeonice/cloud-agent-platform/commit/d6043f779c1bb2faa0f0bac0f916a05770367ddd))
* **web,aio:** WS auto-reconnect + dockerode resource sampler ([a3fe3c7](https://github.com/Xeonice/cloud-agent-platform/commit/a3fe3c727bd5d62274432a5afa3a8c2ec603a14c))
* **web,ci:** cache @cap/web's .vercel/output so cache-hit builds restore it ([15f3fb2](https://github.com/Xeonice/cloud-agent-platform/commit/15f3fb277fdd6ea412e90b5d1a3263f05faed283))
* **web:** delay the CR after a sent command so codex's TUI submits it ([087633c](https://github.com/Xeonice/cloud-agent-platform/commit/087633c34d705343015a8d34a367a995e4ca8b66))
* **web:** persist self-update target so a mid-upgrade refresh resumes the poll ([1eb239d](https://github.com/Xeonice/cloud-agent-platform/commit/1eb239d04001379fa1272cb10fb5502101da5aa7))
* **web:** self-update banner polls /version for completion + auto-refreshes ([df0464a](https://github.com/Xeonice/cloud-agent-platform/commit/df0464ae252f22193c11714beaeed606ee5e290b))
* **web:** wrap long --prompt in the command preview instead of stretching the panel ([ec1eaf1](https://github.com/Xeonice/cloud-agent-platform/commit/ec1eaf1bdd30139789913850481e8ad06a71e9fb))
* **www:** annotate LocaleLayout return type so the static build typechecks ([3a25fe7](https://github.com/Xeonice/cloud-agent-platform/commit/3a25fe71e822ee9f410fe6fe5d6984f0be1fabc2))
* **www:** serve static export via framework:null so Vercel serves out/ (no routes-manifest) ([92345d3](https://github.com/Xeonice/cloud-agent-platform/commit/92345d3910b738b1772aebc77de810ded904b67e))

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
