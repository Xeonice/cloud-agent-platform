## Why

Fast BoxLite native commands can reach a proven poll settlement before CAP's WebSocket attach has completed its handshake; CAP currently closes that attach after one event-loop turn and returns fabricated empty output, causing valid runtime metadata preflight to fail before repository provisioning begins. The executor needs a deterministic, bounded distinction between process settlement and complete output drain so successful commands never expose incomplete output as valid results.

The deployment canary also exposed a related terminal-race gap: a task can be cancelled after BoxLite has created its physical sandbox but before `provision()` returns and CAP records the legacy owner. Terminal cleanup then mistakes the missing owner row for confirmed physical absence, while late provisioning can leave the box running and emit a misleading `provision_failed` audit after cancellation already won. The same change must fence that create window and require provider-backed cleanup evidence before rollout can be considered safe.

## What Changes

- Define provider-neutral command success as requiring both proven process settlement and proven completion of every promised output source, including valid zero-byte output.
- Change BoxLite native exec synchronization to join poll settlement and attach replay/exit under one absolute command deadline, without a fixed post-poll sleep or a second full timeout.
- Preserve a proven native process result when attach fails, while failing the normalized executor call with a typed output-unavailable or protocol outcome instead of returning `exitCode = 0` with fabricated empty output.
- Keep attach degradation and process settlement separately observable through the existing bounded, secret-free diagnostic envelope.
- Add deterministic race, failure, cancellation, fragmentation, empty-output, stress, and real-BoxLite regression coverage, followed by a `vibe-zlyan` task canary.
- Persist an internal legacy create-in-progress fence before crossing a provider's physical create boundary, attach the observed provider sandbox id through compare-and-set, and prevent a late provisioning result from resurrecting ownership after terminal cleanup has won.
- Replace synthetic “already absent” cleanup for missing legacy ownership with provider-backed teardown/absence evidence, and keep cancellation as the truthful terminal winner without a later force-failed audit.
- Keep Public V1, MCP, OpenAPI, API Playground, task schemas, database schema, and repository/Gitee behavior unchanged.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `boxlite-sandbox-provider`: Require native poll and attach/output-drain completion to converge under one deadline before returning a successful normalized command result.
- `sandbox-provider-port`: Define complete output settlement as part of provider-neutral command success, extend split-channel conformance, fence provider-side sandbox creation before it can become externally visible, and require physical cleanup evidence across terminal races.
- `observability`: Distinguish authoritative process settlement, output-unavailable degradation, and the consuming operation outcome; make terminal cleanup and stop-winner diagnostics truthful without exposing command or output material.

## Impact

- Affected implementation: `@cap/sandbox-provider-boxlite` native execution/attach state machine and typed failure handling; provider-center legacy ownership fencing; API owner-store persistence and Guardrails terminal-race settlement.
- Affected shared validation: sandbox provider command conformance and BoxLite unit, coverage, stress, and gated E2E stories.
- Affected specifications: BoxLite command normalization, provider-neutral executor/conformance, and provisioning diagnostic causal semantics.
- Unchanged surfaces: orchestration remains provider-neutral; toolchain metadata parsing, Public V1, MCP, OpenAPI, API Playground, database schema, and task failure wire contracts do not change. Existing internal `sandbox_runs` create-state fields carry the fence.
- Dependencies and deployment: no new runtime dependency or BoxLite upgrade is required; rollout verification targets the currently deployed BoxLite v0.9.5 protocol before any optional independent upgrade.
