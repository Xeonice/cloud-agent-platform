# Research brief — fail-loud-on-unknown-runtime

Baseline: working branch on top of `origin/main` @ v0.46.1, after the test-discovery and request-boundary changes. Every claim below was re-verified by reading the code, not carried over.

## The shape

Adding a runtime is supposed to be additive. Today it is additive *and silent*: the compiler accepts a new `RuntimeId` and the system keeps running, taking the wrong branch at a dozen forks. The failure mode is not an error — it is a task that quietly executes as a different agent, reads the wrong credential table, or skips its image preflight entirely.

Measured, excluding tests: **14** `runtime === '<literal>'` comparisons across 7 backend files, and about **10** more across 4 frontend files. What matters is not the count but that almost none of them have an exhaustive or throwing default.

## Verified degradation chains

**A third runtime executes as codex.** `agent-runtime.integration.ts:219` returns `null` for an unrecognised runtime — with a `warn`, so it is not literally silent — and `resolveForTask` hands that `null` to `AgentRuntimeRegistry.resolve`, whose first line is `const id = runtime ?? DEFAULT_RUNTIME_ID`. The task then runs as codex. A log line is not a gate. The irony is on the record: the surrounding comment describes the v0.6.0 regression where claude tasks were silently routed to codex.

**The wrong credential table is read.** `prisma-runtime-model-credential.resolver.ts:41`:

```ts
return runtime === 'codex' ? this.resolveCodex(ownerUserId) : this.resolveClaude(ownerUserId);
```

Anything that is not `codex` resolves against the Claude credential — for a third runtime, a table that could not possibly hold its credential.

**Image preflight is skipped entirely.** `sandbox-environments.validator.ts` builds probes with `if (normalizedRuntimeId === 'codex') { … }` / `if (… === 'claude-code') { … }` and ends `return []`. An unknown runtime gets **no probes at all** — no `command -v`, no artifact checksum — so the environment validates as fine and the failure surfaces much later as an operational error with no connection to its cause.

**Transcripts are mislabelled.** `agent-runtime.port.ts:110`:

```ts
return runtime === 'claude-code' ? 'claude-jsonl' : 'codex-rollout';
```

Everything that is not claude-code is declared a codex rollout, including a format nobody has written a parser for. This is also a double-write: the same fact lives on each runtime's `transcriptFormat`, and a consistency test exists precisely because the two can drift — a test compensating for a shortcut rather than the shortcut being removed.

**The console drops readiness for an unknown runtime.** `apps/web/src/lib/api/real.ts` filters readiness entries on an `id === "claude-code" || id === "codex"` whitelist, so a backend that reports a third runtime has that entry discarded and the option renders as permanently un-ready.

**A promised extension point does not exist.** `agent-runtime.port.ts` documents `readTranscriptSource` as the seam where a future multi-record runtime declares a non-JSONL strategy "additively, WITHOUT editing codex/claude". Both consumers — `configured-provider.ts:907` and `:950` — are `if (kind !== 'single-newest-jsonl') return null`. An unrecognised strategy yields "this task has no transcript", with no error and no log. The strategy type has exactly one member, so nothing can currently express the case; the note describes a mechanism that was never built.

## The repository already knows how to do this

Three places fail correctly, and they are the template:

- `parse-transcript.ts:23` — `{ [F in TranscriptFormat]: TranscriptParser<F> }`, an exhaustive mapped type. Adding a format **breaks the build** until a parser exists.
- `runtime-model-rejection-evidence.ts:26` — `Record<RuntimeId, string>` for CLI pins. Same property.
- `agent-runtime.registry.ts:52` — `throw new Error('no runtime registered for "…"')`. Loud at the only place that can still be recovered from.

So this is not a technique the codebase lacks. It is applied in 3 places out of roughly 24.

## Corroboration from the last two changes

This session produced direct evidence that silent tolerance costs real time. Four separate test fixtures were built without fields the code later came to require — `role` on a session principal (twice), `method` on a request (four files) — and each was tolerated until something finally read the field. Every one surfaced as a confusing failure far from its cause. That is the same disease one layer up: a missing thing accepted rather than refused.

## Scope boundary

**In scope**: the runtime axis — the comparisons above, the two false seams, and the type-level changes that make a new `RuntimeId` fail at compile time wherever a decision depends on it.

**Deliberately out of scope**:

- **`router.ts`'s 14 `provider.<method>?.()` calls.** Real, and the same family — a missing method is indistinguishable from a method returning null. But provider optionality is exactly what the role-interface decomposition later in the programme replaces with type-level facts. Converting them to runtime `typeof` checks now would be work thrown away, and would entrench the flat-port shape the decomposition removes.
- **Opening `RuntimeId` to a branded string.** That belongs with the runtime-axis completion (credentials, model catalogue, image probes). This change makes the *existing* closed set fail loudly; opening the set is the next step and is much safer once nothing degrades silently.
- **The `sandbox-provider-aio` terminal-ownership flake** recorded during the previous change. Unrelated, still open.

## The spec already forbids this, and its own check would fail

`openspec/specs/agent-runtime/spec.md` carries **"No agent-identity branch exists in shared scaffolding"**:

> Shared scaffolding SHALL NOT branch on agent identity (`runtime.id === 'codex'`, `!== 'codex'`, or equivalent) — this applies to the pty client, the provider, the liveness poller, and **any integration/registry wiring**. Any per-agent difference SHALL be carried by the runtime's declared policy and read by the mechanism.

Its verification scenario demands that "a grep of the shared-scaffolding sources for `id === 'codex'` / `id !== 'codex'` finds **zero matches**".

That scenario fails today, in the two areas the requirement names by hand:

- **integration/registry wiring** — `agent-runtime.integration.ts:219`: `if (value === 'claude-code' || value === 'codex') return value;`
- **the provider / host-harness** — `configured-provider.ts:663-664`:

```ts
const key = args.runtimeId === 'claude' ? 'claude-code' : args.runtimeId;
if ((key === 'codex' || key === 'claude-code') && !metadata.dependencies[key]) { … throw … }
```

The second is worse than a mislabel: the guard is **fail-open**. The dependency-declaration check only runs for the two known ids, so an unrecognised runtime skips validation entirely and provisions against an image that never declared it.

So the requirement does not need to be invented — it needs to be enforced, extended past the pty-client scope it was written for, and given a check that runs. The change is closing the gap between a rule the project already wrote down and the code that ignores it.
