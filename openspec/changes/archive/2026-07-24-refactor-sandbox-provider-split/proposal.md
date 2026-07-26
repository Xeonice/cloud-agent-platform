## Why

The sandbox execution layer had accumulated too many responsibilities inside the API package: local AIO container lifecycle, clone/workspace setup, provider selection, transcript materialization, retention cleanup, and e2e harness assumptions were all coupled to one concrete implementation. That made the current local self-host path work, but it left no clean seam for managed/cloud sandbox providers and made tests brittle around terminal startup details.

This change records the already-applied sandbox split and the e2e fixes that made the split verifiable end to end.

## What Changes

- Extract sandbox primitives into workspace packages:
  - `@cap/sandbox-core` for provider contracts, capabilities, and descriptors.
  - `@cap/sandbox-scheduler` for capability/location/priority-based selection.
  - `@cap/sandbox-lifecycle` for settle/provision plan helpers.
  - `@cap/sandbox-workspace-git` for clone/workspace planning.
  - `@cap/sandbox-provider-aio` and `@cap/sandbox-aio-local` for local AIO behavior.
  - `@cap/sandbox-cloud-http` for a managed HTTP provider adapter.
  - `@cap/sandbox-conformance` and `@cap/sandbox` for provider verification and facade exports.
- Keep API orchestration thin: `GuardrailsService` resolves a provision plan, selects an eligible provider, provisions with a clone spec, and settles through a shared settle plan.
- Make transcript and retention reads provider-neutral instead of hard-wired to the local AIO provider.
- Add cloud provider environment knobs while preserving local AIO as the default.
- Fix reconnect replay consistency by flushing the per-task `session.log` append chain before building reconnect frames.
- Update AIO e2e so it verifies the current contracts: automatic codex launch, reconnect replay after async auth, clone success/failure inside the real sandbox container, and script token alignment with the compose API env.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `sandbox-provider-port`: provider descriptors, capability matching, provider-neutral transcript/retention reads, and package boundaries.
- `aio-sandbox-execution`: AIO remains the default local provider, but receives typed clone specs and shares conformance/e2e behavior with the provider facade.
- `session-sandbox-retention`: retention cleanup and retained transcript reads operate through the selected provider/retention store rather than a concrete AIO class.
- `realtime-terminal`: reconnect replay waits for already-observed PTY bytes to flush into `session.log` before reading snapshot/tail frames.

## Impact

- **Code:** API sandbox module/wiring, guardrails lifecycle, retention cleaner, transcript controllers, AIO provider implementation, terminal gateway, e2e harness.
- **Packages:** adds sandbox workspace packages and expands `pnpm-workspace.yaml` to include `packages/*`.
- **Config:** adds optional cloud sandbox env vars; local AIO remains the fallback/default.
- **Behavior:** provisioning now fails closed when no provider satisfies required capabilities; reconnect replay is consistent with live bytes already emitted; AIO e2e no longer depends on racing a shell before codex auto-attach.
