## Context

`agent-runtime` already forbids branching on agent identity in shared scaffolding, and asks for a grep that finds zero matches. The grep would fail today in the two areas the requirement names: the integration/registry wiring (`agent-runtime.integration.ts:219`) and the provider/host-harness (`configured-provider.ts:663-664`). Details and the full inventory are in the research brief.

Two facts shape the work more than the count does.

**The rule exists; only its reach and its enforcement are missing.** It was written during the pty-client refactor and its scope reads that way — pty client, provider, liveness poller, registry wiring. The same shape has since appeared in credential resolution, image preflight, transcript format and model-catalogue routing, none of which the sentence anticipated. And its verification is a described grep that nothing runs, so the rule has depended on review since the day it was written.

**Three correct patterns are already in the tree.** An exhaustive mapped type (`parse-transcript.ts:23`), a `Record<RuntimeId, …>` (`runtime-model-rejection-evidence.ts:26`), and a throwing registry (`agent-runtime.registry.ts:52`). Nothing needs inventing — the technique is present and applied in 3 sites out of roughly 24.

## Goals / Non-Goals

**Goals:**
- Adding a runtime id becomes a compile error at every site that must decide something for it.
- Where a total mapping does not fit, an unrecognised runtime raises a named error instead of taking a plausible branch.
- The fail-open image-dependency guard becomes fail-closed.
- The existing requirement gets a check that runs.
- Zero behaviour change for codex and claude-code.

**Non-Goals:**
- Opening `RuntimeId` past its closed set. That is the runtime-axis completion, and it is far safer once nothing degrades silently.
- `router.ts`'s optional provider calls. Same family, but provider optionality is what the role-interface decomposition converts into type-level facts; converting them to runtime `typeof` checks now would be discarded work.
- Adding a third runtime. This change makes that addition *loud*, it does not perform it.

## Decisions

**Prefer a total mapping over a checked switch, and a throw over both.**
In order of preference: a `Record<RuntimeId, T>` or mapped type, because the compiler enumerates the cases and a missing one cannot ship; an exhaustive switch with a `never`-typed default where the shape resists a record; a named throw where the decision is not total at all. The first is strictly better than a lint rule — it cannot be silenced or forgotten, and the failure arrives at the moment the id is added rather than when the branch is next executed.

**Delete `transcriptFormatForRuntime`, do not fix it.**
Its ternary is one half of a double-write: the same fact is declared on each runtime's `transcriptFormat`. A consistency test exists solely to catch the two drifting. Resolving the format through the registry removes the second source, and the test goes with it — a test that compensates for a shortcut should not outlive the shortcut. The one constraint is that the persistence read path has only the stored id, not a runtime instance, so the registry lookup has to be reachable there; that is the piece to verify first.

**Decide the `readTranscriptSource` seam explicitly rather than leaving the note.**
It is documented as the additive extension point for a future multi-record runtime, but both consumers are `if (kind !== 'single-newest-jsonl') return null` and the strategy type has exactly one member — the mechanism was never built. Leaving the promise in place while making everything else loud would preserve the one lie that this change exists to remove. Either the consumers dispatch on the strategy for real, or the doc comment stops promising it. Given the type has a single member and no second implementation exists to shape a dispatch against, the honest move is to remove the promise now and let the runtime-axis change build the seam when it has a real second case to build against. Recorded rather than quietly chosen.

**Enforce the requirement with a source check, not a lint rule.**
The requirement is phrased as a grep, so the check is a grep — a test that scans the shared-scaffolding sources for agent-identity comparisons and fails naming the file and line. A lint rule would need per-file suppressions the moment a *runtime implementation* legitimately mentions its own id, and those suppressions are how the rule rots. The check carries an explicit list of the paths that count as shared scaffolding, which is reviewable in a way an inline disable comment is not.

**Frontend: render what the backend reports.**
The readiness whitelist is a client re-deriving a server fact. Removing the filter means an unknown id renders with whatever label the server supplies rather than disappearing. The label helpers keep a fallback so an unlabelled id shows as itself instead of as "Codex".

## Risks / Trade-offs

**A wide mechanical diff across live execution paths** → Every file in scope now has running tests, which was not true two changes ago; that is precisely what makes this change safe to attempt now. Mitigation is ordering: convert one decision family at a time, run the full suite between each, so a regression is attributable to the family that introduced it.

**A throw replaces a working default** → Any path that today survives on the codex fallback will now raise. That is the intent, but if a *legitimate* caller passes `null` or an empty runtime for a task that predates the column, it would break. Mitigation: the distinction is "absent" versus "unrecognised" — an absent runtime keeps its documented default, only an unrecognised one raises. That boundary must be tested from both sides.

**The enforcement check becomes noise** → A scan for `=== 'codex'` will match runtime implementations, which legitimately name themselves. Mitigation: the check scans an explicit list of shared-scaffolding paths, not the whole tree, so a runtime's own file is out of scope by construction rather than by suppression.

**Removing the transcript-format ternary touches a persistence read path** → The stored id is all that path has. If the registry is not reachable there, the double-write cannot be removed the way this design assumes. Mitigation: that reachability is the first thing the implementation verifies, before any deletion; if it does not hold, the design note is wrong and the artifact gets corrected rather than the shortcut preserved.

## Migration Plan

Each step is independently revertible, and the suite runs between steps:

1. Add the enforcement check and let it fail, listing today's violations — the inventory becomes executable rather than a document.
2. Convert the transcript-format decision (delete the ternary, resolve through the registry, remove the consistency test), after verifying registry reachability on the persistence read path.
3. Convert credential resolution and model-catalogue routing to total mappings.
4. Convert image preflight, and make the dependency guard fail-closed.
5. Make runtime resolution raise on an unrecognised id while preserving the absent-id default.
6. Remove the frontend readiness whitelist and the two-value assumptions in the label helpers.
7. Resolve the `readTranscriptSource` promise per the decision above.
8. The enforcement check now passes; it becomes a merge gate.

## Open Questions

Both were answered before implementation began; kept here with their answers rather than deleted, so the reasoning that unblocked the plan stays visible.

- ~~Is the registry reachable from the persistence transcript read path?~~ **Yes, on both paths.** `SessionTranscriptService` is a Nest service that already injects `SANDBOX_PROVIDER` and `PrismaService`, so it can take `RUNTIME_REGISTRY` (exported by the `@Global()` sandbox module) the same way. `readTaskTranscript` is a pure function, so it needs the registry threaded through its existing `deps` parameter — its three callers (`v1-transcript.controller`, `session-history.controller`, `mcp.server`) are all Nest components that can inject it. One new `deps` field, no structural obstacle. Step 2 proceeds as designed.
- ~~Does any stored task carry a runtime value outside the current union?~~ **No path in the system can produce one.** `tasks.runtime` is a nullable `TEXT` column with **no CHECK constraint and no default** (migration `20260618000000_add_task_runtime`), but every write is schema-validated against `RuntimeSchema` — a two-value `z.enum` — and legacy rows backfilled to `NULL`. So the stored domain is `codex` | `claude-code` | `NULL`. The absent case keeps its default, as the design already requires; a hand-edited row would now fail loudly, which is the correct treatment of "unrecognised". Step 5 proceeds as designed.
