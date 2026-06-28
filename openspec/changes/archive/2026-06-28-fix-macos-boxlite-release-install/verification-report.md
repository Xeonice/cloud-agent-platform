# Verification Report

Change: `fix-macos-boxlite-release-install`

Date: 2026-06-28; updated 2026-06-29

## Focused Checks

- `sh -n scripts/install-preflight.sh && sh -n apps/www/public/install.sh && bash -n scripts/quick-deploy.sh`
  - Passed.
- `node scripts/install-preflight.test.mjs`
  - Passed: 48 assertions, including dependency reporting for BoxLite macOS Hypervisor.framework and Linux KVM requirements.
- `node scripts/quick-deploy-preflight.test.mjs`
  - Passed: 44 assertions, including BoxLite local macOS Hypervisor checks, Linux `/dev/kvm` checks, external endpoint skip behavior, and the configurable API health timeout path.
- `pnpm --filter @cap/sandbox-scheduler build && node packages/sandbox-scheduler/src/sandbox-scheduler.test.mjs`
  - Passed: 25 tests.
- `pnpm --filter @cap/sandbox-provider-boxlite test`
  - Passed: client/provider/conformance/coverage tests; live BoxLite integration stayed opt-in and skipped without `BOXLITE_LIVE_TEST=1`.
- `node apps/api/src/terminal/boxlite-terminal-transport.test.mjs`
  - Passed: 13 assertions.
- `node apps/api/src/terminal/terminal-transport-selection.test.mjs`
  - Passed: 7 assertions.
- `node apps/api/src/sandbox/sandbox-provider-family.test.mjs`
  - Passed: 3 tests.
- `pnpm --filter @cap/www test:assets`
  - Passed: the static export injector publishes `install.sh`, `quick-deploy.sh`, `install-preflight.sh`, and `docker-compose.prod.yml`; the published scripts have no unreplaced install markers and the compose asset carries the CAP managed marker.
- `pnpm --filter @cap/api typecheck`
  - Passed.
- `pnpm --filter @cap/api build`
  - Passed.
- `pnpm --filter @cap/api lint`
  - Passed.
- `pnpm --filter @cap/www typecheck`
  - Passed.
- `pnpm --filter @cap/www lint`
  - Passed.

## GitHub Dependency Validation

Initial command shape:

```sh
RUN_GITHUB_VALIDATION=1 \
CAP_WORKDIR="$(mktemp -d /tmp/cap-github-validation.XXXXXX)" \
CAP_TEST_UNAME=Linux \
CAP_TEST_ARCH=x86_64 \
CAP_SANDBOX_PROVIDER=control-plane \
CAP_QUICK_DEPLOY_STOP_AFTER=provider-readiness \
CAP_VERSION=v0.25.0 \
WITH_WEB=0 \
bash scripts/quick-deploy.sh
```

Initial result:

- Used the local ignored `.env.github-validation` token source.
- Logged only `GitHub validation: using local token from env/ignored file (redacted)`.
- GitHub API returned HTTP 200.
- Exact token value had zero tracked-file hits.

## Linux/AIO Release-Image Smoke

Command shape:

```sh
CAP_WORKDIR=/tmp/cap-aio-smoke.Frds1X \
CAP_TEST_UNAME=Linux \
CAP_TEST_ARCH=x86_64 \
CAP_SANDBOX_PROVIDER=aio \
CAP_IMAGE_PLATFORM=linux/amd64 \
API_HOST_PORT=19080 \
WEB_HOST_PORT=19300 \
WITH_WEB=1 \
bash scripts/quick-deploy.sh
```

Result:

- Docker preflight passed and reported existing Docker was usable, so it left Docker untouched.
- Latest Release resolved to `v0.25.0`.
- The managed `docker-compose.prod.yml` run package was written to the temp workdir.
- `ghcr.io/xeonice/cap-aio-sandbox:v0.25.0` was pulled and validated by `docker image inspect`.
- `docker compose up -d` created and started `api`, `postgres`, and `web`, but the local Docker Desktop engine then sent SIGKILL to `api`, `postgres`, and `web` and destroyed those containers within seconds.
- Docker events showed exit code 137 and `destroy` for `cap-aio-smokefrds1x-api-1`, `cap-aio-smokefrds1x-postgres-1`, and `cap-aio-smokefrds1x-web-1`.
- Retrying only `api postgres`, and retrying with a temporary `cap-net: external: true` override, produced the same SIGKILL/destroy behavior.

Conclusion:

- Release asset fetching, Docker preflight, latest resolution, managed compose writing, and AIO image staging were verified.
- `/version`, password login, and task provisioning smoke could not be completed on this local Docker Desktop environment because the engine removed the runtime containers before the API could become healthy.
- No source build, `git clone`, `make up`, or local image build was used.

Follow-up completed on 2026-06-29 after Docker Desktop was usable again:

```sh
CAP_WORKDIR=/tmp/cap-aio-release-smoke.ylMYcM \
CAP_VERSION=v0.25.0 \
CAP_TEST_UNAME=Linux \
CAP_TEST_ARCH=x86_64 \
CAP_SANDBOX_PROVIDER=aio \
CAP_IMAGE_PLATFORM=linux/amd64 \
API_PORT=19180 \
WEB_PORT=19130 \
WITH_WEB=0 \
RUN_SMOKE=0 \
CAP_HEALTH_TIMEOUT_SECONDS=600 \
COMPOSE_PROJECT_NAME=capaiocapaioreleasesmokeylmycm \
bash scripts/quick-deploy.sh
```

Follow-up result:

- Docker preflight passed and left usable Docker untouched (`server 29.5.3 linux/arm64`).
- `ghcr.io/xeonice/cap-aio-sandbox:v0.25.0`, `ghcr.io/xeonice/cap-api:v0.25.0`, and `postgres:16-alpine` were pulled as release images.
- AIO readiness validated the staged sandbox image.
- `/version` returned `{"version":"v0.25.0","gitSha":"2f9539cff889a1c06d22573a7f70643f2489e386","buildTime":"2026-06-27T16:25:34Z"}`.
- Password login and first-login password change passed.
- A repo for `https://github.com/octocat/Hello-World.git` was created through the API.
- Task `d632433e-277f-408b-bf8d-b7d268c9a949` reached `running`, proving AIO sandbox provisioning.
- The temporary compose stack and volumes were removed with `docker compose down -v --remove-orphans`.

## macOS/lume E2E

Environment:

- VM: `cap-lume-e2e-run`, macOS `26.5.1`, `lume ssh` verified usable despite `lume get` still reporting `sshAvailable:false`.
- Host-to-VM internet required a local CONNECT proxy at `192.168.64.1:18082`; VM-to-host BoxLite used `BOXLITE_ENDPOINT=http://192.168.64.1:7331`.
- Real local BoxLite endpoint responded at `/v1/default/boxes`; readiness created and deleted runtime probe sandboxes with image `mcr.microsoft.com/devcontainers/base:debian`.
- The ignored `.env.github-validation` token was copied into the VM workdir and used only for the GitHub validation smoke; logs reported the token source as redacted.

Docker/Colima findings:

- The first absent-Docker run installed Xcode Command Line Tools via Apple Software Update after configuring the VM system proxy, installed Homebrew, and installed Docker CLI, Compose, Colima, and QEMU.
- Default Colima failed inside the Lume macOS VM because nested virtualization is unavailable: the VZ path reported `Virtualization is not available on this hardware`.
- Colima `--vm-type qemu` still generated QEMU args with `-machine virt,accel=hvf`; Lima/Colima 2.1.3/0.10.3 expose no supported accelerator option in `colima start --help` or the Lima JSON schema.
- A maintainer-only test harness using Lima's `QEMU_SYSTEM_AARCH64` hook plus a wrapper that rewrites `accel=hvf` to `accel=tcg` proved Docker can become usable in this nested VM: `docker-server=29.5.2 os=linux arch=aarch64`. This is not treated as the production default path.

Release-image install run:

```sh
CAP_VERSION=v0.25.0 \
CAP_INSTALL_BASE=http://192.168.64.1:18081 \
CAP_RAW_BASE=http://192.168.64.1:18081 \
CAP_WORKDIR=/Users/lume/cap-release-e2e \
CAP_SANDBOX_PROVIDER=boxlite \
BOXLITE_ENDPOINT=http://192.168.64.1:7331 \
BOXLITE_READINESS_ENDPOINT=http://192.168.64.1:7331 \
BOXLITE_API_TOKEN=<redacted> \
BOXLITE_IMAGE=mcr.microsoft.com/devcontainers/base:debian \
BOXLITE_PROTOCOL_MODE=native \
RUN_GITHUB_VALIDATION=1 \
curl -fsSL http://192.168.64.1:18081/install.sh | sh
```

Result:

- The source-free install path did not `git clone`, run `make up`, or build images locally.
- Docker preflight saw a usable Docker engine and left it untouched.
- GitHub validation returned HTTP 200 and redacted the token source.
- BoxLite native readiness and runtime image/workspace/tools probe passed.
- Published release images `ghcr.io/xeonice/cap-api:v0.25.0`, `cap-web:v0.25.0`, and `postgres:16-alpine` were pulled and started.
- The first run with the old 120s health deadline failed because amd64 release images on nested macOS/arm64 TCG took about six minutes to finish API startup. `quick-deploy.sh` now uses `CAP_HEALTH_TIMEOUT_SECONDS`, defaulting to 600s for macOS/arm64 running `linux/amd64`; the rerun printed `waiting up to 600s for api /health` and completed.
- VM-internal console URL: `http://localhost:3000` loaded HTML. Direct host access to `192.168.64.20:3000` timed out in this local Lume NAT/routing setup.
- `/version`: `{"version":"v0.25.0","gitSha":"2f9539cff889a1c06d22573a7f70643f2489e386","buildTime":"2026-06-27T16:25:34Z"}`.
- Printed admin: `admin@example.com` / `cap_admin_e9689afeee6309ac67cebcffd516eb55`; the first-login password change smoke changed the current password to `cap_admin_e2e_changed_20260628_A1`.

Task smoke:

- Login, first-login password change, repo creation, and task creation all returned success HTTP statuses.
- Task `5f05357c-bb21-4ba1-90b8-3ddf42c91bcd` reached `task.running` then failed with `force_failed:provision_failed`.
- API log root cause: `BoxLite request POST /v1/sandboxes failed: HTTP 404`.

Local-image follow-up:

- Built local `linux/arm64` images with tag `local-boxlite-e2e` and loaded them into the Lume VM Docker engine instead of pulling GHCR:
  - `ghcr.io/xeonice/cap-api:local-boxlite-e2e`
  - `ghcr.io/xeonice/cap-web:local-boxlite-e2e`
- Added `.dockerignore` so Docker builds do not copy stale `dist/` or `*.tsbuildinfo` into the image build context; this prevents a source-changed provider package from reusing old compiled output.
- The first local API image moved the failure from old `/v1/sandboxes` to native `/v1/default/boxes`, proving the local provider path was in use.
- Live BoxLite 0.9 compatibility fixes found and validated with local images:
  - native create must omit unsupported `labels`;
  - native create must call `POST /v1/default/boxes/:id/start`;
  - native create must not set `working_dir` to a workspace path that does not exist yet;
  - BoxLite HTTP errors now include the response body.
- With `BOXLITE_IMAGE=buildpack-deps:bookworm-scm`, the local-image task `56452e88-3d5d-4ac7-a98a-42b7202e14ca` stayed `running`.
- Audit events for that task contained `task.created` and `task.running`, with no `force_failed:provision_failed`.
- BoxLite listed a running box:
  - name: `cap-boxlite-56452e88-3d5d-4ac7-a98a-42b7202e14ca`
  - image: `buildpack-deps:bookworm-scm`
  - status: `running`
- Direct BoxLite exec confirmed the workspace was cloned:
  - `/tmp/cap-workspace/.git`
  - `/tmp/cap-workspace/README`
  - `origin https://github.com/octocat/Hello-World.git`

Reset-and-rerun local-image verification:

- Reset target: deleted/recreated `cap-lume-e2e-run`. The `cap-lume-base-20260628` clone refused SSH, so the successful rerun used the clean `cap-lume-boxlite-e2e` base.
- Nested Docker dependency: the reset VM already had Homebrew Docker/Compose/Colima installed but no running docker.sock. QEMU `11.0.1` and `/Users/lume/.local/share/qemu/edk2-aarch64-code.fd` were required for Colima/QEMU inside Lume; after adding the firmware and using the existing QEMU wrapper, Colima reported `server=29.5.2 os=linux arch=aarch64` and Compose `5.2.0`.
- Installer preflight from the local site mirror returned `Docker CLI, Compose, and engine are usable; leaving Docker untouched`, proving the updated macOS Homebrew-path detection does not reinstall an existing Docker stack.
- `quick-deploy.sh` with `CAP_QUICK_DEPLOY_STOP_AFTER=provider-readiness` passed native BoxLite endpoint/token/image checks and the create/start/exec runtime probe before any GHCR pull.
- Loaded local prebuilt images into the VM Docker engine and started the release compose with `--pull never --no-build`:
  - `ghcr.io/xeonice/cap-api:local-lume-reset-e2e`
  - `ghcr.io/xeonice/cap-web:local-lume-reset-e2e`
  - `postgres:16-alpine`
- VM-internal console URL: `http://127.0.0.1:3000` returned HTTP 200. Direct host access to `192.168.64.22:{22,3000,8080}` timed out under this Lume NAT setup, so API/browser URL checks were made inside the VM.
- `/version`: `{"version":"local-lume-reset-e2e","gitSha":"2f9539cff889a1c06d22573a7f70643f2489e386","buildTime":"2026-06-28T16:12:07Z"}`.
- Admin credentials generated by quick-deploy: `admin@example.com` / `cap_admin_c1d6c8afcb6e745f592854d6b40ab429`. Password login returned `mustChangePassword=true`; the forced change-password endpoint was then exercised by setting the new password to the same generated value, yielding `mustChangePassword=false`.
- Task `a0727c13-b27d-448d-b10a-7da1a421846a` reached `running`. BoxLite listed `cap-boxlite-a0727c13-b27d-448d-b10a-7da1a421846a` as `Running`; direct `boxlite exec` showed `/tmp/cap-workspace/.git`, `/tmp/cap-workspace/README`, and `origin https://github.com/octocat/Hello-World.git`.
- Observed non-blocking follow-up: `ResourceSamplerService` logged repeated warnings that no running container was readable via cgroup or docker stats for the BoxLite-backed task. It did not block task startup or workspace materialization.

VM-local BoxLite control-plane verification:

- Purpose: verify the stricter topology where BoxLite itself runs inside the Lume macOS VM, while CAP API/Web/Postgres run in that same VM's Colima/Docker layer and the API container reaches BoxLite through the VM host.
- Copied the host's BoxLite `0.9.5` arm64 binary plus `~/Library/Application Support/boxlite/runtimes/v0.9.5` into the VM under `/Users/lume/bin/boxlite` and `/Users/lume/Library/Application Support/boxlite/runtimes/v0.9.5`.
- VM binary smoke passed: `/Users/lume/bin/boxlite --version` returned `boxlite 0.9.5`.
- Control-plane startup failed before any sandbox create:
  - command: `/Users/lume/bin/boxlite serve --host 0.0.0.0 --port 7331`
  - error: `unsupported: Hypervisor.framework is not available`
  - suggestion printed by BoxLite: `Check: sysctl kern.hv_support`
- VM hypervisor check confirmed the cause: `sysctl kern.hv_support` returned `kern.hv_support: 0`.
- No BoxLite REST listener was created on `127.0.0.1:7331`, so `/v1/default/boxes` could not be reached and the VM-local sandbox-start check could not proceed.

Conclusion:

- The installer, dependency gates, real BoxLite readiness, GitHub validation, `/version`, password login, and console loading are verified in local Lume.
- The reset-and-rerun local-image validation proves the current code can provision a native BoxLite task and clone the repository in the VM-backed deployment using release compose semantics without `git clone`, `make up`, local VM builds, GHCR pulls, or `docker compose up --build`.
- That proof used a BoxLite control plane running on the host and reachable from inside the VM. The stricter co-located topology, where BoxLite itself runs inside the Lume VM, is blocked because BoxLite requires Hypervisor.framework and this Lume VM reports `kern.hv_support: 0`.
- A later release publish should still run the same Lume task smoke against the newly published tag, because the older published `v0.25.0` image predates this native BoxLite provider implementation and still calls the old `/v1/sandboxes` route.

## Secret and Debugger Scan

- `.env.github-validation` is ignored and not tracked.
- Exact validation token value: zero tracked-file hits.
- Generic tracked `github_pat_`/`ghp_` hits are pre-existing test/example fixtures only.
- Current changed files have no JavaScript breakpoint-statement hits except the OpenSpec task text that asks for that scan.
