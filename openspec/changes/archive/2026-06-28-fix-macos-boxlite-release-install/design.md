## Context

The release-image install path is now the public self-host path: `install.sh` delegates to `quick-deploy.sh`, fetches the source-free `docker-compose.prod.yml`, and runs GHCR release images. A live macOS arm64 deployment showed that this path can pass API/web health while task startup is still broken because Docker, run-package freshness, BoxLite readiness, and provider selection are not verified as one end-to-end contract.

The existing BoxLite provider is capability-gated, but CAP currently registers AIO unconditionally and BoxLite optionally. That makes `CAP_SANDBOX_PROVIDER=boxlite` advisory rather than authoritative. The deployed BoxLite 0.9.5 control plane also exposes native `/v1/default/boxes` routes, while CAP's BoxLite REST client expects `/v1/sandboxes`; the live host relied on an unmanaged Python adapter that was not running.

## Goals / Non-Goals

**Goals:**

- Make release-image install reliable on macOS and Linux without requiring a source clone, `make up`, or local image build.
- Install Docker only when absent; leave an already usable Docker install untouched.
- Verify external install dependencies explicitly and distinguish install-time from task-time dependencies.
- Ensure selected sandbox provider readiness is verified before reporting install success or before an enabled provision smoke passes.
- Make explicit provider selection fail closed: a forced BoxLite install cannot silently use AIO.
- Productize BoxLite protocol compatibility and terminal capability declarations.
- Add a real macOS end-to-end verification path using `lume`.

**Non-Goals:**

- Installing, upgrading, or reinstalling Docker/Homebrew when the required Docker
  components are already usable.
- Replacing the source development `make up` flow.
- Building release images locally during install.
- Making public DNS, TLS, reverse proxy, or firewall configuration automatic.
- Embedding GitHub, OpenAI, Claude, or SMTP secrets into tracked files.

## Decisions

### D1 - Dependency preflight is layered, not one flat check

The installer will report four buckets:

- host tools: shell, `curl`, `openssl`, `awk`, Docker CLI, Docker Compose plugin;
- Docker engine: daemon/socket/context usable by the current user;
- release assets: site assets, GitHub latest-release API when `CAP_VERSION` is not pinned, GHCR CAP images, Docker Hub `postgres`;
- selected provider: AIO image staged on Linux/AIO; BoxLite endpoint/token/image/protocol readiness on macOS/BoxLite.

Task-time dependencies such as repository hosting, package registries, OpenAI/Claude auth, and SMTP remain documented and optionally smoke-tested, but do not block a basic install unless their corresponding smoke is enabled.

Alternative considered: require every possible runtime dependency at install time. Rejected because a password-only local console install should not fail because SMTP, OpenAI, Claude, or a private repo token is absent.

### D2 - Docker installation is absence-only

If Docker CLI/Compose/engine are already usable, the installer does nothing to Docker. If Docker is absent on Linux, the installer may use the OS package manager to install Docker Engine and the Compose plugin, then start the service and verify `docker info`. If the Docker CLI exists but Compose is missing, the installer installs only the Compose plugin and does not reinstall Docker Engine. If Docker is absent on macOS, the installer installs only missing Homebrew formulae for Docker CLI, Compose, and Colima, bootstrapping Homebrew non-interactively only when Homebrew itself is absent and Docker/Compose installation is required. If Docker CLI exists but only the Compose plugin is missing on macOS, the installer first links an existing Homebrew plugin if present, otherwise installs only the missing `docker-compose` formula.

If Docker is installed but the daemon is not reachable, the installer treats that as a state issue, not an installation issue. It may perform bounded safe starts such as `systemctl start docker` or `colima start`, but it must not reinstall or upgrade Docker.

Alternative considered: always reinstall or upgrade Docker when checks fail. Rejected because it risks disrupting existing Docker Desktop, Colima, and production contexts.

### D3 - `quick-deploy.sh` must be pipe-safe and macOS-safe

The script cannot depend on `BASH_SOURCE[0]` when it is executed from stdin. When no script path exists, it should treat itself as site-served and fetch the compose asset from `CAP_RAW_BASE` or the injected site base. Time-bounded commands should use a portable helper that falls back to an internal wait loop when GNU `timeout` is absent.

Alternative considered: document "download then execute" as the only supported path. Rejected because the public installer intentionally delegates through a pipe and the site advertises inspectable one-liners.

### D4 - Managed run-package files should refresh safely

The run directory may already contain a stale `docker-compose.prod.yml`. `quick-deploy.sh` should detect files it manages and refresh them from the current source, backing up the old copy before replacement. It should not overwrite user-managed files unless a force/update flag is set or the file carries a managed marker. `.env` remains secret-preserving, but operational keys for the selected provider, public ports, and same-host endpoint discovery should be corrected to match the run.

Alternative considered: always reuse existing compose. Rejected because stale compose caused the web console to call the wrong API port on the live host.

### D5 - Provider override constrains the registry

`CAP_SANDBOX_PROVIDER=aio|boxlite|control-plane` should decide the eligible provider set. In explicit BoxLite mode, AIO should not be registered as a fallback candidate. In `auto` mode, OS policy chooses a default, and capability selection still applies within the eligible set. Invalid explicit provider configuration should fail provider registration or task provisioning with a clear error rather than falling through to another backend.

Alternative considered: keep provider override as metadata and rely only on priorities. Rejected because it hides misconfigured BoxLite by starting unintended AIO containers.

### D6 - BoxLite protocol compatibility belongs in CAP, not an ad-hoc host file

The preferred implementation is a native BoxLite REST client mode for BoxLite 0.9.5 routes (`/v1/default/boxes`, `/exec`, `/executions/:id/attach`, files/archive equivalents). If native support is not completed in the first implementation, any adapter must be packaged, installed, supervised, health-checked, and versioned by the run package. An untracked deployment-directory Python script is not an acceptable contract.

Terminal capability must match reality. If BoxLite attach/PTY transport is not implemented in CAP, the provider must not advertise `terminal.websocket` or `terminal.interactive`, and installer smoke should fail clearly for interactive task mode rather than reporting a usable sandbox.

Alternative considered: keep the existing `/v1/sandboxes` client and ask operators to run an adapter. Rejected because it repeats the exact live failure: endpoint configured, adapter absent, task fails later.

### D7 - GitHub validation token is local test input only

GitHub API validation may use a local ignored env file such as `.env.github-validation` to avoid unauthenticated rate limits during tests. The implementation and docs must reference the variable name, not any token value. Tests and logs must redact the token and must not require it for normal unit tests.

Alternative considered: write the token into OpenSpec or a tracked fixture. Rejected because it is a secret even if temporary.

### D8 - `lume` is the real macOS gate

Unit and integration tests should cover shell and provider behavior, but the acceptance gate for this incident class is a clean macOS VM using `lume`: install Docker/Colima as needed, run the site install path, verify `/version`, login, selected provider readiness, GitHub dependency validation when token is present, and a task smoke appropriate to the implemented BoxLite capability set.

## Risks / Trade-offs

- Docker installation differs across Linux distributions -> keep installer support to a documented set and fail with exact commands for unsupported distros.
- macOS Docker/Colima install can be slow and stateful -> only install when absent and make `lume` E2E maintainer-run rather than a default unit test.
- BoxLite native attach protocol may need deeper investigation -> gate terminal capability until attach transport is implemented and conformance-tested.
- Explicit provider constraint may expose existing hidden misconfigurations -> this is the intended fail-closed behavior; error messages and docs must point to the missing dependency.
- GitHub test token may expire or be revoked -> tests using it must be optional and skip with a clear message when the local ignored env file is absent or invalid.

## Migration Plan

1. Ship script and provider changes in a release image.
2. Existing installs can rerun `install.sh`/`quick-deploy.sh`; managed compose files are backed up before refresh and `.env` secrets are preserved.
3. macOS installs with broken BoxLite config will fail earlier instead of creating AIO containers.
4. Rollback is the previous release tag plus the backed-up compose file; no schema migration is required.
