## Why

The BoxLite provider work makes Mac hosts a viable target, but the installer still treats Apple Silicon as control-plane-only and leaves users without a default sandbox. We need the install/startup path to select a usable sandbox backend by platform: BoxLite by default on macOS, AIO by default on Linux, with explicit all-interface exposure that leaves public networking to the operator.

## What Changes

- Update the source installer and local startup scripts so host platform detection selects the sandbox backend:
  - macOS defaults to a BoxLite-backed sandbox path.
  - Linux defaults to the existing AIO-backed sandbox path.
  - Explicit overrides remain available for operators and CI.
- Add a BoxLite startup/config path for macOS that writes or validates the required `BOXLITE_*` env and fails clearly if BoxLite cannot be started or reached.
- Preserve the existing AIO full-stack default on Linux, including AIO image build/staging and compose e2e behavior.
- Make startup scripts and docs explicit that api/web host ports bind on `0.0.0.0` by default, while public domain, TLS, reverse proxy, firewall, and OAuth/cookie public origin configuration remain user-managed.
- Update install docs/site copy and tests so the advertised default behavior matches the scripts.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `one-line-installer`: change platform defaults from arm64 control-plane-only guidance to macOS BoxLite default and Linux AIO default.
- `multi-target-deploy`: update one-command local bring-up semantics to support provider auto-selection and explicit all-interface host exposure.
- `agent-oneclick-deploy`: clarify how the prebuilt quick-deploy path relates to the new platform defaults and preserve its amd64/AIO constraints unless a BoxLite-backed source-free path is explicitly implemented.
- `release-and-versioning`: update run-package/install docs and validation expectations where they describe AIO-only/default host architecture behavior.

## Impact

- **Code:** `apps/www/public/install.sh`, `scripts/dev-up.sh`, `scripts/gen-local-env.sh`, `Makefile`, compose/env examples, deploy docs, installer/compose tests, and possibly a new local BoxLite startup helper.
- **Config:** new provider-selection env such as `CAP_SANDBOX_PROVIDER=auto|aio|boxlite`, plus generated `BOXLITE_*` values for the macOS path when BoxLite is available.
- **Behavior:** macOS installs should start a BoxLite-capable sandbox by default instead of only the control plane. Linux installs continue to start AIO by default. The api/web services are advertised as binding `0.0.0.0` by default; public exposure remains an explicit operator networking task.
- **Dependencies:** implementation may add a local BoxLite service/daemon requirement or compose profile, depending on the chosen BoxLite packaging route.
