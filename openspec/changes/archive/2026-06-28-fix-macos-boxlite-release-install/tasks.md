## 1. Track: installer-docker-preflight (depends: none)

- [x] 1.1 Add shared shell helpers for host tool checks, Docker state detection, and bounded command execution without GNU `timeout`.
- [x] 1.2 Update `apps/www/public/install.sh` to verify `curl`, `bash`, `openssl`, and `awk`, classify Docker as usable/absent/unreachable, and leave usable Docker untouched.
- [x] 1.3 Implement the supported Linux absent-Docker path: install Docker Engine plus the Compose plugin through the detected package manager, start the service, and continue only after `docker info` works.
- [x] 1.4 Implement the supported macOS absent-Docker path: when Homebrew is present install Docker CLI, Compose, and Colima, start Colima, and continue only after `docker info` works.
- [x] 1.5 Ensure installed-but-unreachable Docker is treated as a daemon/socket/context problem: perform only bounded safe starts, then fail with exact remediation without reinstalling or upgrading Docker.
- [x] 1.6 Add shell tests with mocked `uname`, `PATH`, `docker`, `brew`, `systemctl`, and `colima` covering usable Docker no-op, absent Docker install, missing Homebrew, and unreachable Docker failure.
- [x] 1.7 Refine Docker dependency detection so Docker CLI, Compose plugin, and engine reachability are handled separately: install only absent components, leave usable installs untouched, and never reinstall Docker for unreachable daemon/socket/context failures.

## 2. Track: quick-deploy-run-package (depends: installer-docker-preflight)

- [x] 2.1 Make `scripts/quick-deploy.sh` stdin-safe by removing unsafe `BASH_SOURCE[0]` assumptions and using a site/raw-base run-package fetch path when no script directory exists.
- [x] 2.2 Replace GNU `timeout` usage in Docker/context probes with the portable bounded helper from the installer track.
- [x] 2.3 Add managed run-package markers for `docker-compose.prod.yml` and refresh stale managed copies with timestamped backups while refusing to overwrite user-managed compose files by default.
- [x] 2.4 Preserve operator secrets in `.env` while correcting operational pins for `CAP_VERSION`, public ports, selected provider, same-host endpoint discovery, and BoxLite endpoint/image/capability keys on each run.
- [x] 2.5 Add install-time dependency reporting that separates host tools, Docker engine, release asset endpoints, image registries, selected-provider readiness, and optional task-time dependencies.
- [x] 2.6 Gate success on selected-provider readiness: pull/stage the matching AIO sandbox image for Linux/AIO, and validate BoxLite endpoint, token, image, protocol mode, runtime tools, host virtualization dependencies for local endpoints, and capability compatibility for macOS/BoxLite.
- [x] 2.7 Add optional GitHub dependency validation using `GITHUB_VALIDATION_TOKEN` from process env or an ignored `.env.github-validation` file, with token redaction and unauthenticated/skip behavior when absent.
- [x] 2.8 Add shell/static tests for piped execution, macOS without GNU `timeout`, stale managed compose refresh, user-managed compose refusal, provider readiness failure, BoxLite local Hypervisor/KVM checks, and GitHub token redaction.
- [x] 2.9 Align quick-deploy's native BoxLite readiness probe with the live 0.9 create/start/exec contract: omit create-time `working_dir`, call `/start`, then exec workspace/tool checks.

## 3. Track: provider-selection-fail-closed (depends: none)

- [x] 3.1 Update API sandbox provider wiring so `CAP_SANDBOX_PROVIDER=aio|boxlite|control-plane` constrains the eligible provider family instead of registering AIO as an unconditional fallback.
- [x] 3.2 Keep `auto` mode platform-aware while making invalid explicit provider configuration fail during registration or provisioning with the selected family named in the error.
- [x] 3.3 Extend scheduler/router errors to include rejected candidate ids, missing capabilities, and the explicit provider family when one was configured.
- [x] 3.4 Add unit tests proving explicit BoxLite never provisions AIO, explicit AIO never selects BoxLite, auto mode still uses capability selection within the chosen family, and errors are actionable.

## 4. Track: boxlite-native-runtime (depends: provider-selection-fail-closed)

- [x] 4.1 Add BoxLite protocol-mode configuration for the provider, defaulting the release install path to a CAP-supported native BoxLite protocol rather than an unmanaged host adapter.
- [x] 4.2 Implement native BoxLite REST support for BoxLite 0.9.x routes, including sandbox create/get/delete, command exec, workspace file/archive transfer, resize, signal, and execution attach primitives.
- [x] 4.3 Implement a CAP-side BoxLite terminal transport behind `TerminalGateway` and `terminal-transport-selection.ts`, with attach, input, output, resize, close, and reconnect semantics covered by tests.
- [x] 4.4 Make BoxLite capability declarations derived from implemented protocol and transport support; do not advertise `terminal.websocket` or `terminal.interactive` unless the terminal transport conformance passes.
- [x] 4.5 Add BoxLite readiness probes that create a sandbox, verify image/workspace assumptions, run required tool probes, and tear down the probe sandbox on success and failure.
- [x] 4.6 Add fake-fetch/unit/conformance tests for native BoxLite endpoints, runtime preflight failures, terminal transport behavior, capability gating, and cleanup paths.

## 5. Track: docs-and-release-assets (depends: quick-deploy-run-package, boxlite-native-runtime)

- [x] 5.1 Update English and Chinese self-hosting docs to enumerate install-time required dependencies, selected-provider dependencies, and optional task-time dependencies separately.
- [x] 5.2 Document Docker installation behavior: install only when absent, leave existing usable Docker untouched, and treat installed-but-unreachable Docker as a state/remediation problem.
- [x] 5.3 Update BoxLite docs and env examples to describe the supported native protocol, required `BOXLITE_*` values, readiness checks, and terminal capability expectations.
- [x] 5.4 Update release-image install copy and site-served assets so the public path remains source-free: no `git clone`, no `make up`, and no local image build.
- [x] 5.5 Add or update build/site asset injection tests proving `install.sh`, `quick-deploy.sh`, and `docker-compose.prod.yml` are published together with the expected managed markers.
- [x] 5.6 Update OpenSpec and self-hosting docs to describe component-level Docker dependency installation, macOS Homebrew bootstrap boundaries, BoxLite native create/start/exec readiness, and task-time optional dependencies.

## 6. Track: verification-e2e (depends: docs-and-release-assets)

- [x] 6.1 Run focused unit/static checks for installer helpers, quick-deploy tests, sandbox scheduler tests, BoxLite provider tests, terminal transport tests, and API typecheck/build surfaces touched by the change.
- [x] 6.2 Run a Linux/AIO release-image smoke verifying Docker preflight, AIO sandbox image staging, `/version`, password login, and a task provisioning smoke without cloning or building locally.
  - Verified on 2026-06-29 with a temporary release-image compose stack using `CAP_VERSION=v0.25.0`, `CAP_SANDBOX_PROVIDER=aio`, `CAP_IMAGE_PLATFORM=linux/amd64`, `WITH_WEB=0`, no `git clone`, no `make up`, and no local image build. Docker preflight left usable Docker untouched, the AIO sandbox image was staged, `/version` returned `v0.25.0`, password login and first-login password change passed, repo `https://github.com/octocat/Hello-World.git` was created through the API, task `d632433e-277f-408b-bf8d-b7d268c9a949` reached `running`, and the temporary compose stack plus volumes were removed.
- [x] 6.3 Use local `lume` to start a clean macOS VM, run the site-style release-image install path, allow Docker/Colima installation only when absent, and verify `/version`, password login, BoxLite readiness, and a real task start.
  - Partially verified on `cap-lume-e2e-run`: `lume ssh` is usable, the site-style installer ran without `git clone`, `make up`, or local image build, Docker/Compose were left untouched once usable, GitHub validation used the ignored local token with redaction, BoxLite native endpoint/readiness/runtime probe passed, compose started the published `v0.25.0` release images, `/version` returned `v0.25.0`, password login and first-login password change worked, and the web console loaded inside the VM.
  - Local-image follow-up verified the current code path before publishing: local `linux/arm64` `cap-api:local-boxlite-e2e` and `cap-web:local-boxlite-e2e` images were loaded into the Lume VM, the API called native BoxLite `/v1/default/boxes`, task `56452e88-3d5d-4ac7-a98a-42b7202e14ca` stayed `running`, and the BoxLite workspace contained a cloned `https://github.com/octocat/Hello-World.git` checkout.
  - Reset-and-rerun verification on `cap-lume-e2e-run` used the clean `cap-lume-boxlite-e2e` base after `cap-lume-base-20260628` refused SSH. The VM needed QEMU plus `edk2-aarch64-code.fd` for nested Colima/QEMU; after that, `docker info` reported `server=29.5.2 os=linux arch=aarch64` and Compose `5.2.0`.
  - The site-style installer preflight fetched from a local HTTP mirror and reported `Docker CLI, Compose, and engine are usable; leaving Docker untouched`, proving already-installed Homebrew Docker/Compose/Colima were not reinstalled.
  - `quick-deploy.sh` with `CAP_QUICK_DEPLOY_STOP_AFTER=provider-readiness` validated native BoxLite endpoint/token/image and passed the create/start/exec runtime probe before any image pull.
  - The current local prebuilt images `ghcr.io/xeonice/cap-api:local-lume-reset-e2e` and `ghcr.io/xeonice/cap-web:local-lume-reset-e2e` plus `postgres:16-alpine` were loaded into Colima and started with the release compose using `--pull never --no-build`; `/version` returned `{"version":"local-lume-reset-e2e","gitSha":"2f9539cff889a1c06d22573a7f70643f2489e386","buildTime":"2026-06-28T16:12:07Z"}`.
  - Password login and forced first-login password change passed; task `a0727c13-b27d-448d-b10a-7da1a421846a` reached `running`, BoxLite listed `cap-boxlite-a0727c13-b27d-448d-b10a-7da1a421846a` as `Running`, and `/tmp/cap-workspace` inside the sandbox contained a cloned `https://github.com/octocat/Hello-World.git` checkout.
  - Host-to-guest direct TCP to `192.168.64.22:{22,3000,8080}` timed out under the current Lume NAT setup, so console/API URL checks were performed from inside the VM (`http://127.0.0.1:3000`, `http://127.0.0.1:8080`) plus BoxLite's host REST endpoint.
  - VM-local BoxLite control-plane verification failed: after copying BoxLite `0.9.5` and its runtime shim into the Lume VM, `/Users/lume/bin/boxlite serve --host 0.0.0.0 --port 7331` exited with `unsupported: Hypervisor.framework is not available`; `sysctl kern.hv_support` returned `0`, and no BoxLite REST listener was created. The supported validation topology is therefore a BoxLite control plane running on a Hypervisor-capable host and reached from the VM; the installer now fails early for a same-host/local BoxLite endpoint when macOS reports `kern.hv_support=0`.
- [x] 6.4 When `.env.github-validation` or `GITHUB_VALIDATION_TOKEN` is present, run the GitHub dependency validation smoke and confirm logs/results redact the token.
- [x] 6.5 Record verification evidence in the change, including commands run, `/version` responses, console URL shape, provider selected, task smoke result, and any skipped external dependency checks.
- [x] 6.6 Before any future commit, scan staged/source changes for `debugger` and confirm no secret token value is present in tracked files, logs, or OpenSpec artifacts.
