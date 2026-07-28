## Why

The project already wrote this rule down. `agent-runtime`'s requirement **"No agent-identity branch exists in shared scaffolding"** forbids branching on `runtime.id === 'codex'` "in the pty client, the provider, the liveness poller, and any integration/registry wiring", and its verification scenario demands a grep for such branches find **zero matches**.

That scenario fails today, in the two areas the requirement names by hand:

- **integration/registry wiring** — `agent-runtime.integration.ts:219` recognises exactly two ids and returns `null` for anything else; `AgentRuntimeRegistry.resolve` then maps `null` to `DEFAULT_RUNTIME_ID`. A third runtime's task **executes as codex**. There is a `warn`, which is not a gate. The comment beside it describes the v0.6.0 regression where claude tasks were silently routed to codex.
- **the provider / host-harness** — `configured-provider.ts:663-664` gates the sandbox-metadata dependency check on `key === 'codex' || key === 'claude-code'`, so an unrecognised runtime **skips image validation entirely**. That one is fail-open.

Beyond those two, the same shape recurs: `runtime === 'codex' ? resolveCodex : resolveClaude` reads the **wrong credential table**; the environment validator returns `[]` so an unknown runtime gets **no preflight probes at all**; `transcriptFormatForRuntime` labels everything that is not claude-code a codex rollout; the console's readiness list discards ids outside a two-value whitelist. Measured, excluding tests: 14 such comparisons across 7 backend files and about 10 more in the frontend.

None of this is a technique the codebase lacks. Three places already fail correctly — an exhaustive mapped type in `parse-transcript.ts`, a `Record<RuntimeId, …>` in `runtime-model-rejection-evidence.ts`, and a throw in `agent-runtime.registry.ts`. The pattern is applied in 3 places out of roughly 24.

This lands before the deeper refactors because it is their safety net: for the rest of the programme, a decision that depends on runtime identity should refuse to compile when a case is added, rather than pick a plausible wrong branch at runtime.

## What Changes

- **Make the closed set exhaustive at the type level.** Where a decision maps every runtime to a value — transcript format, credential resolution, preflight probes, model-catalogue routing — express it as a total mapping (`Record<RuntimeId, …>` or an exhaustively-checked switch) so adding an id is a **compile error** at every site that must decide something.
- **Make the remaining runtime forks throw rather than fall through.** Where a total mapping does not fit, the default branch raises a named error instead of silently choosing a side. This includes the fail-open image-dependency guard, which becomes fail-closed.
- **Remove the double-write.** `transcriptFormatForRuntime`'s ternary is deleted in favour of the runtime's declared `transcriptFormat`, resolved through the registry; the consistency test that exists to catch the two drifting apart goes with it.
- **Delete the false seam, or build it.** `readTranscriptSource` is documented as an additive extension point but both consumers silently return `null` for anything unrecognised, and the strategy type has one member. Either it dispatches for real or the promise comes out of the doc comment — the change picks one and says which.
- **Stop the console discarding unknown runtimes.** Readiness entries are rendered from what the backend reports rather than filtered against a hardcoded pair.
- **Give the existing requirement a check that runs.** Its scenario asks for a grep result; nothing performs it. A test asserts the shared-scaffolding sources carry no agent-identity branch, so the rule stops depending on review.

No behaviour changes for codex or claude-code: every branch keeps its current outcome for the two ids that exist.

## Capabilities

### Modified Capabilities
- `agent-runtime`: its "No agent-identity branch exists in shared scaffolding" requirement is widened past the pty-client-era scope it was written in — covering credential resolution, image preflight, transcript format and model-catalogue routing — and gains the property that a decision keyed on runtime identity SHALL fail loudly (compile error where the mapping is total, named error otherwise) rather than fall through to a default. Its verification scenario becomes an executable check rather than a described grep.

## Impact

- **Backend**: `agent-runtime/` (port, integration, registry), `runtime-models/` (credential resolver, catalogue port), `sandbox-environments/` (validator), `tasks/` (failure mapping), and `packages/sandbox/src/host-harness/configured-provider.ts`.
- **Frontend**: `apps/web/src/lib/api/real.ts` readiness parsing, plus the label/alert helpers that assume a pair.
- **Tests**: a new check enforcing the no-identity-branch requirement; the transcript-format consistency test is removed along with the double-write it guarded.
- **Risk**: this is a wide, mechanical diff over live execution paths. It is covered by the suites the first change in this programme mounted — every one of these files now has running tests, which was not true two changes ago.
- **Not in scope** (recorded in the research brief with reasons): `router.ts`'s 14 optional provider calls, which the role-interface decomposition replaces with type-level facts later in the programme; and opening `RuntimeId` beyond its closed set, which belongs with the runtime-axis completion and is safer once nothing degrades silently.
