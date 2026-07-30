## Context

`apps/api` has no written layout contract, and 37 top-level directories grew
without one. The measurements that matter (see `research-brief.md`): 814 `../`
imports, all exactly one level deep; 147 cross-directory edges; 14 pairs
importing each other; `apps/web` already using `@/*` while `apps/api` has no
`paths` at all.

Three decisions were the repository owner's to make and were taken before this
design was written:

1. Shared symbols move to **concern-named directories** (`crypto/`, `http/`, …),
   not a single `shared/`. The name is the contract; `shared/` names nothing and
   becomes the next catch-all.
2. The contract **permits `*.module.ts` ↔ `*.module.ts`** (Nest DI composition)
   and **forbids non-module mutual dependencies**. 5 of 14 pairs are therefore
   permitted by the contract rather than by omission; 9 are broken.
3. Cycles are broken **in this change**, not deferred, so the contract can take
   effect immediately rather than shipping with an enumerated debt list.

Constraints:

- `apps/api` is a Nest application compiled by `nest build`, and its test suites
  include `.mjs` harnesses that compile individual `.ts` sources with a bare
  `tsc` invocation. A path alias must resolve in ALL of those, not only in the
  project `tsconfig`. This is the single highest-risk part of the change.
- No product behaviour may change. Every edit is a path, a symbol's home, or a
  direction.

## Goals / Non-Goals

**Goals**

- `monorepo-foundation` states a layout contract for the first time.
- `apps/api` imports by alias, matching `apps/web`.
- The 9 logic cycles are gone; the 5 permitted module-composition pairs are
  permitted explicitly, in the contract's words.
- A gate that fails on a new cycle or a new `../` import, self-testing and in CI.

**Non-Goals**

- Reorganising the 37 directories into layers. This change makes moving them
  mechanical; it does not move them. Deciding the layering is separate work with
  its own evidence.
- Splitting the repository, or separating backend apps from frontend apps —
  complaints 1 and 3 of the original four. Both need this groundwork first.
- Touching `apps/web`, `apps/www`, or the packages. The contract is written to
  apply repository-wide where it already holds; only `apps/api` needs changing
  to meet it.
- Reducing `guardrails.service.ts`. Independent debt.

## Decisions

### D1 — `@/*` in `apps/api`, following `apps/web`

Not a preference: `apps/web` already maps `@/*` → `./src/*`, so adopting it
makes one convention where there were two-minus-one. Inventing a different one
(package-name self-reference, or `~/`) would leave the repository with two
answers to the same question.

**The risk is resolution, not syntax.** The alias must work in the Nest build,
in `node --test` over compiled `dist`, and in the `.mjs` harnesses that invoke
`tsc` on single files. Each of those is verified independently before the bulk
rewrite, not after — a rewrite of 814 imports discovered to be unresolvable in
one harness is far more expensive to unpick than to prevent.

*Alternative considered — leave the imports alone and only add the contract.*
Rejected: the contract's purpose is to make relocation mechanical, and 814
one-level relative imports are exactly what makes relocation unmechanical.

### D2 — Concern-named homes, one symbol group per directory

Each extracted symbol goes to a directory named for what it IS:

| Symbol(s) | Home | From |
|---|---|---|
| `decryptStored` | `crypto/` | `settings` (pulled by `forge` and `repos`) |
| `AuthenticatedRequest`, `isAdminPrincipal` | `http/` | `auth` (pulled by `mail`) |
| `taskFailureMessage`, `taskFailureTitle` | *(to be named during implementation)* | `tasks` (pulled by `audit`) |
| `isValidMaxConcurrentTasks` | *(with the settings validators it belongs to)* | `settings` (pulled by `guardrails`) |
| `RunnerMinutesLedger`, `SemaphoreProjectionSource` | *(to be decided against the code)* | `metrics` (pulled by `guardrails`) |
| `PublicSurfaceError`, `normalizePublicSurfaceFailure`, … | *(to be decided against the code)* | `public-surface` (pulled by `mcp`) |

The rows left open are deliberate. Naming a home for a symbol whose
responsibility has not been read is how a `shared/` bucket forms under a
different label — each is decided during implementation, with the code in hand,
and recorded.

*Alternative considered — a single `shared/`.* Rejected by the owner: it names
nothing, so nothing stops the next unrelated symbol landing there.

*Alternative considered — pure shapes into `@cap/contracts`.* Rejected as the
blanket answer: it would split symbols that are one concern (`AuthenticatedRequest`
is a shape, `isAdminPrincipal` is a predicate over it) across a package
boundary. Where a symbol is genuinely a shared wire shape, contracts remains its
home — but that is decided per symbol, not as a rule.

### D3 — Composition may cycle; logic may not

The contract's rule is about the FILE, not the directory: a `*.module.ts` may
import another module, because Nest's composition model routinely requires it
and a blanket ban would be satisfied with `forwardRef` indirection that hides
the same cycle. Non-module source forming a mutual dependency is forbidden.

This is a real line, not a loophole — but **it turned out to exempt NOTHING.**

Measured properly during implementation: of the twelve cycles remaining after
the shared-symbol moves, **not one is pure module↔module composition.** Every
pair has ordinary source on at least one side. The earlier "5 permitted, 9 to
break" split came from reading only each cycle's THIN edge — seeing
`tasks.module.ts` import `GuardrailsModule` and calling it composition, while the
thick edge carried `guardrails.service.ts → tasks.service`.

So the exemption stays in the contract (it is the right rule, and a future cycle
may qualify) while changing nothing about the work: all twelve break, 55
non-composition imports in total. The owner re-decided the scope on that
corrected basis.

**Implementation consequence:** the gate classifies by the IMPORTING file. A
first wording said only module→module counts as composition, which
implementation showed to be unsatisfiable: a Nest module MUST import the
provider CLASSES it registers, so `guardrails.module.ts → SessionTranscriptService`
is composition too. What the rule actually targets is a cycle in which any
participating import is written in ordinary source — and after the port
inversion below, `tasks ⟷ guardrails` has none left.

### D4 — Break the two inversions at the seam they belong to

- `agent-runtime → sandbox` for `PROVISION_LOOKUP` / `ProvisionLookup`: the
  runtime integration reaches into `sandbox` for a DI token and port type, while
  5 of the 6 imports in the opposite direction are type-only. The port belongs
  where both can depend on it without either depending on the other.
- `agent-runtime → terminal` for `buildDetachedCodexLaunchLine`,
  `buildHasSessionCommand`, `wrapInDetachedSession`, …: the runtime POLICY
  objects reach into the terminal MECHANISM for command construction. This is a
  residual edge across the exact seam `refactor-agent-runtime-policy-mechanism`
  established, pointing the wrong way. Whether the command builders belong to
  the runtimes (policy declaring its own launch line) or behind a declared
  interface is decided by reading them — recorded, not assumed here.

### D5 — One shared compile helper for the single-file harnesses

Ten `.mjs` harnesses each hand-write the same `tsc` invocation. They must become
paths-aware, and the honest way is one shared helper rather than ten edits: the
duplication is itself a defect with a track record — two of these harnesses were
found missing `--strict` in an earlier change, silently compiling to a different
baseline than the project does.

The helper generates a tsconfig carrying `paths`, the caller's explicit flags,
and `files: [<the one source>]`, then invokes `tsc -p`. Single-file compilation
is preserved; only how the compiler is told about it changes.

### D6 — The gate covers what the contract says

Two checks, both data-driven and self-testing, in the shape of
`agent-identity-branch-check` and `provider-contract-parity-check`:

- no `../` import inside `apps/api/src`;
- no mutual dependency between two directories other than module-to-module.

Wired into CI beside the other three, after the violations are gone.

## Risks / Trade-offs

- **[The alias does not resolve in one of the build/test paths]** → **This
  happened.** Two lanes were fine; the ten single-file `tsc` harnesses were not,
  for a structural reason (no `--project`, and no `--paths` CLI flag). Handled by
  making the harnesses paths-aware through a shared compile helper rather than by
  adopting a second convention for them — the option the task explicitly warned
  against. That the risk was checked with ONE aliased import before rewriting 814
  is what kept this cheap.
- **[A moved symbol changes behaviour]** → Moves are pure relocations; the full
  suite plus typecheck is the check. The `.mjs` harnesses that compile real
  sources are what catch a resolution error a project-wide typecheck would miss.
- **[Breaking an inversion changes DI wiring and the app stops booting]** →
  Typecheck does not catch a Nest provider that no longer resolves. The boot
  probe in CI does, and `apps/api`'s DI-shaped tests do. A previous change in
  this programme broke DI in exactly this way and was caught by tests, not the
  compiler — the same care applies.
- **[The concern-named directories become the new scattering]** → Each name must
  describe a single responsibility, and the open rows in D2 are decided with the
  code in hand. If a symbol has no honest concern name, that is a signal it
  belongs where it already is and the cycle should be broken the other way.
- **[Scope]** → This is materially larger than the five preceding changes: 814
  mechanical edits plus 9 cycles across core paths (`tasks`, `guardrails`,
  `terminal`). The tracks are ordered so the mechanical half lands and is
  verified before the cycles are touched.

## Migration Plan

No deployment step, no data migration, no operator-facing change.

Order: prove alias resolution → rewrite imports → verify → break cycles →
write the contract → gate last, so CI is never knowingly red. Same sequencing
the previous three changes used.

Rollback is a revert; nothing is persisted.

## Open Questions

- Where do the four unnamed symbol groups in D2 belong? Decided during
  implementation by reading each one's responsibility. If a group resists an
  honest name, that is evidence to break the cycle in the other direction
  instead.
- Do the terminal command builders belong to the runtimes, or behind a declared
  interface? Answered by reading them, not assumed.
- ~~Does the alias need a runtime resolver for the compiled Nest output?~~
  **Answered by experiment, and it split the lanes.** `nest build` REWRITES the
  alias — emitted output is `require("../prisma/prisma.service")`, with no `@/`
  surviving anywhere in `dist` — so no runtime resolver is needed, and
  `node --test` over `dist` passes unchanged (76/76 on the probe). But the TEN
  `.mjs` harnesses that invoke `tsc` with explicit flags and NO `--project`
  never see `paths` at all, and `tsc` has no `--paths` CLI flag: introducing one
  aliased import into such a harness's compile graph fails it outright. Verified
  fix: hand the compiler a generated tsconfig carrying `paths`, the harness's
  existing explicit flags, and `files: [<the one file>]` — exit code 0. This is
  the reason for track 2 below.
