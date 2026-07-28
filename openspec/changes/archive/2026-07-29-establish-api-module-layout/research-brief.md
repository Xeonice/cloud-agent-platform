# Research brief — establish-api-module-layout

Serial research pass (no fan-out). Measured against commit `43aca22`.

## Method

Unlike the five preceding changes, this one could NOT start from "a rule was
written and the code drifted" — because there is no rule. So the research began
by looking for one, found none, and then measured the actual shape of the code
so the rule that gets written is grounded in what exists rather than in generic
best practice.

## F1 — There is no layout rule to enforce

`openspec/specs/monorepo-foundation/spec.md` carries ten requirements. All ten
are about toolchain and process: the pnpm/Turborepo workspace, the contracts
package as the single source of shared shapes, strict-TypeScript in three
places, build ordering, the typecheck-lint-build command, CI gates, boot probes,
downstream-consumer validation, contracts tests, and public-surface commands.

**Not one of them says anything about module layout, directory structure,
import direction, or path conventions.** The repository has never written down
what its own backend is supposed to look like inside.

That is why this change begins with a spec addition rather than a code fix, and
why the shape of that addition is a decision for the repository owner rather
than something derivable from the code.

## F2 — The alias convention already exists, on one side of the repo

| Package | `compilerOptions.paths` |
|---|---|
| `apps/web` | `{"@/*": ["./src/*"]}` |
| `apps/api` | none |

So `@/` is already this repository's answer for "refer to something by its place
in the package, not by counting `../`". The backend simply never adopted it:
**814 `../` imports** across `apps/api/src`. There are zero `../../` imports —
every relative import is exactly one level, which means the aliasing is a
mechanical, low-risk substitution rather than a path-arithmetic exercise.

## F3 — The dependency graph, measured

`apps/api/src` holds **37 top-level directories**, 68,892 lines of production
TypeScript, with **147 distinct cross-directory edges** carrying **347
references**.

Most depended-upon (in-degree): `prisma` 53, `auth` 50, `tasks` 33,
`sandbox` 27, `forge` 21, `repos` 17, `settings` 15.
Most dependent (out-degree): `v1` 44, `tasks` 37, `guardrails` 34,
`sandbox` 25, `mcp` 23.

## F4 — Fourteen directory pairs import each other

This is the constraint that shapes the whole change: a layering contract cannot
simply be declared while these exist.

Classifying each cycle by its THIN side — the direction with fewer imports, and
therefore the one to invert — they fall into three groups:

**A. Nest module composition (5 pairs).** The thin edge is a `*.module.ts`
importing another module or its service for DI:

| Pair | Thin edge |
|---|---|
| `tasks ⟷ guardrails` | `tasks.module.ts` imports `GuardrailsModule`, `GuardrailsService` |
| `terminal ⟷ tasks` | `terminal.module.ts` imports `TasksModule` |
| `task-admission ⟷ guardrails` | `fenced-task-admission.processor.ts` imports `GuardrailsService` |
| `task-admission ⟷ tasks` | `tasks.module.ts` imports `TaskAdmissionModule` |
| `v1 ⟷ public-surface` | `public-surface-evidence.ts` imports `V1Module` |

Module composition is normal in Nest; what makes these cycles is that the
composition is expressed as a source import in both directions.

**B. A shared thing living inside a feature directory (7 pairs).** The thin edge
pulls a helper or type OUT of a feature module that has no business owning it:

| Pair | What crosses | Note |
|---|---|---|
| `settings ⟷ forge` | `decryptStored` | same helper as below |
| `settings ⟷ repos` | `decryptStored` | two features reach into `settings` for one crypto helper |
| `settings ⟷ guardrails` | `isValidMaxConcurrentTasks` | a validator |
| `tasks ⟷ audit` | `taskFailureMessage`, `taskFailureTitle` | message formatting |
| `auth ⟷ mail` | `AuthenticatedRequest` (type), `isAdminPrincipal` | request-shape + a guard predicate |
| `metrics ⟷ guardrails` | `RunnerMinutesLedger`, `SemaphoreProjectionSource` (type) | |
| `mcp ⟷ public-surface` | `PublicSurfaceError`, `normalizePublicSurfaceFailure`, … | |

This group is the bulk and the most mechanical: the shared symbol moves to a
neutral home and both sides import it from there.

**C. A genuine inversion (2 pairs).**

| Pair | Thin edge |
|---|---|
| `sandbox ⟷ agent-runtime` | `agent-runtime.integration.ts` imports `PROVISION_LOOKUP` / `ProvisionLookup` from `sandbox` (5 of the 6 opposite-direction imports are type-only) |
| `terminal ⟷ agent-runtime` | the two runtimes import `buildDetachedCodexLaunchLine`, `buildHasSessionCommand`, `wrapInDetachedSession`… from `terminal` |

The second is the interesting one: the runtime POLICY objects reach into the
terminal MECHANISM for command construction — the same policy/mechanism seam the
`refactor-agent-runtime-policy-mechanism` work was about, with a residual edge
left pointing the wrong way.

Total: roughly 60 import statements across the 14 pairs, 1–8 per direction. Each
cycle is a focused edit, not a rewrite.

## Open questions carried into design

- What layering does the repository actually want? The measurement suggests a
  natural stratification (`prisma`/`auth` as the most-depended-upon foundation,
  `v1`/`mcp` as the outermost surfaces), but adopting it is a decision, not a
  deduction.
- Where should group B's shared symbols live? A single `shared/` directory, a
  per-concern home (`crypto/`, `http/`), or `@cap/contracts` where the symbol is
  a pure shape. This must be settled before moving anything, since the wrong
  home would simply relocate the coupling.
- Do the group A module-composition cycles need breaking at all, or should the
  contract permit `*.module.ts` to import another module while forbidding
  non-module source from doing so? Nest's composition model makes a blanket ban
  unrealistic; the distinction has to be decided rather than assumed.
