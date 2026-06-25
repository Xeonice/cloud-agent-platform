## 1. Track: package-boundaries (depends: none)

- [x] 1.1 Extract provider core types, capabilities, descriptors, and facades into sandbox workspace packages.
- [x] 1.2 Add provider scheduler and lifecycle helpers for provision/settle planning.
- [x] 1.3 Move AIO-local, cloud HTTP, workspace-git, conformance, and facade exports into packages.
- [x] 1.4 Update pnpm workspace/package dependencies and add sandbox package coverage script.

## 2. Track: api-wiring (depends: package-boundaries)

- [x] 2.1 Wire `SandboxModule` to register local AIO and optional cloud HTTP providers from environment config.
- [x] 2.2 Update `GuardrailsService` to resolve provision plans, select providers by capability, and settle tasks through shared lifecycle plans.
- [x] 2.3 Route delivery, retained transcript reads, and retention cleanup through provider-neutral seams.
- [x] 2.4 Preserve fail-closed behavior when provider requirements cannot be resolved or provisioned.

## 3. Track: replay-and-e2e (depends: api-wiring)

- [x] 3.1 Flush the per-task `session.log` append chain before building reconnect snapshot/tail frames.
- [x] 3.2 Update `scripts/aio-e2e.sh` to use the same `AUTH_TOKEN` as the compose API when not explicitly overridden.
- [x] 3.3 Update AIO e2e reconnect to tolerate async WS auth and verify non-empty replay frames.
- [x] 3.4 Update AIO e2e clone success/failure checks to execute inside the real sandbox container rather than racing terminal shell startup.
- [x] 3.5 Update codex e2e expectations to assert automatic runtime launch plus CPR behavior.

## 4. Track: verification (depends: replay-and-e2e)

- [x] 4.1 Run API lint and sandbox package coverage.
- [x] 4.2 Run API e2e with a temporary Postgres and fake cloud provider.
- [x] 4.3 Run live compose AIO e2e and confirm teardown leaves no running sandbox/compose containers.
- [x] 4.4 Add `verification-report.md` after the checks pass.
