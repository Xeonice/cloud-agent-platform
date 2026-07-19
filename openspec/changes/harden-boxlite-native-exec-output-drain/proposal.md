## Why

Fast BoxLite native commands can reach a proven poll settlement before CAP's WebSocket attach has completed its handshake; CAP currently closes that attach after one event-loop turn and returns fabricated empty output, causing valid runtime metadata preflight to fail before repository provisioning begins. The executor needs a deterministic, bounded distinction between process settlement and complete output drain so successful commands never expose incomplete output as valid results.

## What Changes

- Define provider-neutral command success as requiring both proven process settlement and proven completion of every promised output source, including valid zero-byte output.
- Change BoxLite native exec synchronization to join poll settlement and attach replay/exit under one absolute command deadline, without a fixed post-poll sleep or a second full timeout.
- Preserve a proven native process result when attach fails, while failing the normalized executor call with a typed output-unavailable or protocol outcome instead of returning `exitCode = 0` with fabricated empty output.
- Keep attach degradation and process settlement separately observable through the existing bounded, secret-free diagnostic envelope.
- Add deterministic race, failure, cancellation, fragmentation, empty-output, stress, and real-BoxLite regression coverage, followed by a `vibe-zlyan` task canary.
- Keep Public V1, MCP, OpenAPI, API Playground, task schemas, database state, and repository/Gitee behavior unchanged.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `boxlite-sandbox-provider`: Require native poll and attach/output-drain completion to converge under one deadline before returning a successful normalized command result.
- `sandbox-provider-port`: Define complete output settlement as part of provider-neutral command success and extend provider conformance to cover split settlement channels deterministically.
- `observability`: Distinguish authoritative process settlement, output-unavailable degradation, and the consuming operation outcome without exposing command or output material.

## Impact

- Affected implementation: `@cap/sandbox-provider-boxlite` native execution/attach state machine and typed failure handling.
- Affected shared validation: sandbox provider command conformance and BoxLite unit, coverage, stress, and gated E2E stories.
- Affected specifications: BoxLite command normalization, provider-neutral executor/conformance, and provisioning diagnostic causal semantics.
- Unchanged surfaces: orchestration remains provider-neutral; toolchain metadata parsing, Public V1, MCP, OpenAPI, API Playground, persistence, and task failure wire contracts do not change.
- Dependencies and deployment: no new runtime dependency or BoxLite upgrade is required; rollout verification targets the currently deployed BoxLite v0.9.5 protocol before any optional independent upgrade.
