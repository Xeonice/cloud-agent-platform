<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: enforcement-check (depends: none)

- [x] 1.1 Add a check that scans an explicit list of shared-scaffolding sources for agent-identity comparisons and fails naming file and line; the list is data in the check, reviewable, not inline suppressions
- [x] 1.2 Baseline recorded: **16** violations across 5 files — agent-runtime.integration:219, agent-runtime.port:111, prisma-runtime-model-credential.resolver:41, runtime-model-catalog.port (×5), sandbox-environments.validator (×6), configured-provider (×2). More than the 14 counted by hand: the check also catches the `runtimeId === 'claude'` alias normalisations and multi-line comparisons
- [x] 1.3 Seven cases, all passing — and they earned their keep immediately: three failed on the first run because `listSourceFiles` closed over the module-level ROOT instead of the injected one, so the scan read the real repo rather than the fixture. A gate that cannot be pointed at a fixture cannot be trusted to have been tested
- [x] 1.4 Expose it as a root script so CI and local runs invoke the same command (do NOT wire it into CI yet — it fails until track 7)

## 2. Track: transcript-format (depends: none)

- [x] 2.1 Verified: reachable on both paths. SessionTranscriptService already injects via DI and can take RUNTIME_REGISTRY (exported by the @Global sandbox module); readTaskTranscript is a pure function needing one new field on its existing deps, and all three callers are Nest components. Recorded in design.md
- [x] 2.2 Both consumers now read `registry.resolve(runtime).transcriptFormat`; the ternary and its doc comment are deleted. `IAgentRuntimeRegistry` was widened to expose the field — which made the compiler enumerate every implementation that had to supply it (3 fake registries). `readTaskTranscript` takes the registry through `deps`; its three callers inject it
- [x] 2.3 Removed. It asserted the ternary agreed with each runtime's declaration — there is now only one declaration to disagree with
- [x] 2.4 Confirmed: 1585 tests, 0 failures. The gate went 16 → 15 violations. Caught a REAL DI break on the way: the controllers first injected `AGENT_RUNTIME_REGISTRY_TOKEN`, which TasksModule binds but never exports, so V1Module/McpModule could not resolve it — rewired to the `@Global` `RUNTIME_REGISTRY` token

## 3. Track: credential-and-catalogue (depends: none)

- [x] 3.1 Convert `prisma-runtime-model-credential.resolver.ts`'s `runtime === 'codex' ? resolveCodex : resolveClaude` into a total mapping, so a new id cannot silently read another runtime's credential table
- [x] 3.2 Convert the model-catalogue routing in `runtime-model-catalog.port.ts` the same way, keeping today's outcome for both existing ids
- [x] 3.3 61 runtime-model tests pass unchanged; the gate dropped 15 → 9

## 4. Track: image-preflight (depends: none)

- [x] 4.1 Done: alias lookup table + `asRuntime()` narrowing + `RUNTIME_PREFLIGHT_COMMANDS: Record<Runtime, …>` that THROWS where it used to `return []`; `CAP_RUNTIME_IDS` now derives from the mapping so the list cannot drift from it
- [x] 4.2 The allow-list is GONE rather than extended: this package is deliberately runtime-agnostic (`runtimeId` is an opaque `string | null`), so it has no business knowing which runtimes exist — every non-null id must now appear in the image metadata. The legacy `claude` spelling moved into a `RUNTIME_DEPENDENCY_KEY_ALIASES` table (data, not a branch), which also cleared the gate's last 8 violations
- [x] 4.3 Three cases added: an unrecognised id is refused; an ABSENT id is not treated as unrecognised (both `null` and `undefined`); the legacy `claude` spelling still resolves to the declared `claude-code` dependency
- [x] 4.4 52/52 pass. One PRE-EXISTING test had to change, deliberately: it asserted `runtimeArtifactChecksumFromProbes('custom-runtime', [])` returns `null` — that null is exactly the fail-open contract this change exists to remove (it read as "no checksum required" and skipped artifact verification). Rewritten to assert the throw. No production caller depends on the old return

## 5. Track: resolution-raises (depends: none)

- [x] 5.1 Verified: no path can produce one. The column is nullable TEXT with no CHECK and no default, every write is validated against the two-value RuntimeSchema, and legacy rows backfilled to NULL — stored domain is codex | claude-code | NULL. Recorded in design.md
- [x] 5.2 `IntegrationRuntimeRegistry.readTaskRuntime` now throws `UnknownRuntimeError` (new, in the port). The check is NOT a literal comparison: the registry gained `isRegistered(value): value is RuntimeId`, so the answer comes from what is REGISTERED and a third runtime needs no edit here. This cleared the gate's last violation — 0 of the original 16 remain
- [x] 5.3 `if (value === null) return null;` is now the FIRST branch and carries the reason. The two infrastructure fallbacks (lookup unwired, lookup throwing) deliberately keep their warn-and-default: those are not unrecognised ids, and the design scoped the raise to the stored-value case
- [x] 5.4 66/66 pass. The pre-existing 'out-of-set stored runtime resolves codex AND logs a warning' asserted the OLD contract and was rewritten to assert the raise; the absent-side test that already existed ('an absent runtime (null) defaults to codex WITHOUT a warning') is what stops the two collapsing. Added a case driving both shipped ids through the same narrowing the unknown id fails

## 6. Track: console-readiness (depends: none)

- [x] 6.1 `RuntimeReadiness.id` is now `string` and `getRuntimes` validates STRUCTURE only. The api is the authority on which runtimes exist; a console pinned to the pair it shipped with dropped a newer runtime's entry, which then read as "not ready" — indistinguishable from genuinely unconfigured. The two readiness maps were rekeyed to `string`
- [x] 6.2 `agentLabel` is a total `Record<Runtime, string>` with an unknown id falling back TO ITSELF, and absent still defaulting to Codex. Also folded `schedules.tsx`'s private duplicate of the same ternary onto the shared helper — the drift that helper exists to prevent had already recurred
- [x] 6.3 613/613 web tests pass, typecheck clean

## 7. Track: seam-decision (depends: transcript-format)

- [x] 7.1 The port's doc no longer claims a future runtime can declare a non-single-JSONL strategy without editing the others. It now states plainly that this is NOT YET an extension point: one union member, both runtimes declaring it verbatim, one implementation in every provider
- [x] 7.2 Both providers (AIO, BoxLite) call a shared `assertSingleNewestJsonlSupported`, which THROWS naming the strategy and the provider. `return null` made an unimplemented read indistinguishable from a task with no transcript — the operator saw an empty session with no reason given. Unreachable for both shipped runtimes
- [x] 7.3 Recorded in the port doc itself rather than only in the change, so the next reader of the declaration sees it. A note buried in an archived change is not where someone about to add a runtime looks

## 8. Track: verify-and-gate (depends: enforcement-check, transcript-format, credential-and-catalogue, image-preflight, resolution-raises, console-readiness, seam-decision)

- [x] 8.1 **0 violations, from a baseline of 16.** The last one fell to Track 5's `isRegistered` narrowing
- [x] 8.2 26/26 packages green with the cache fully bypassed; discovery gate reports 412 test files all reachable. Four PRE-EXISTING tests asserted the fail-open contract this change removes and were rewritten to assert the loud failure — each is a deliberate contract change, listed so it is not mistaken for test-fitting:
  - `sandbox-metadata-validation.spec.ts`: `runtimeArtifactChecksumFromProbes('custom-runtime', [])` returned `null` (= "no checksum required", skipping artifact verification)
  - `runtime-selection.spec.ts`: an out-of-set stored runtime "resolves codex AND logs a warning" — a warning does not stop the launch
  - `host-harness-configured-provider.test.mjs` ×2: an unimplemented transcript strategy returned `null` on both the AIO and BoxLite paths, indistinguishable from a task with no transcript
  No behaviour changed for codex or claude-code on any path
- [x] 8.3 Added an `Agent-identity branch gate` step to `ci.yml` next to the discovery gate, running the same `pnpm test:agent-identity` a developer runs. Both the scan and its 7 self-tests run there, so a gate that stopped being able to fail would itself fail
- [x] 8.4 **Nominated `opencode` in `RuntimeSchema` and the build produced 8 errors across 8 distinct decision points** (then reverted; `git diff` on the file is empty):
  - api: credential routing, model-catalogue authorities, image preflight commands, and the terminal gateway where the contract value meets the port's own `RuntimeId`
  - web: the label mapping plus the three create-task call sites
  Before this change, every one of those sites compiled and took a plausible branch — the task would have launched codex under an `opencode` label. Worth recording: `RuntimeId` (the port) and `Runtime` (contracts) are SEPARATE unions, so adding a runtime means editing both — and the compiler now says so at the boundary instead of coercing across it
