## Why

The five preceding changes each closed a gap between a rule the repository had
written down and code that did not follow it. This one cannot: **there is no
rule.** `monorepo-foundation`'s ten requirements cover the toolchain, the
contracts package, strict TypeScript, build ordering and CI gates — and not one
says anything about module layout, import direction, or path conventions. The
backend's internal shape has never been written down, so nothing could drift
from it and nothing can be enforced.

What grew in that vacuum is measurable: `apps/api/src` holds **37 top-level
directories** and 68,892 lines of production TypeScript, wired together by
**814 `../` relative imports** and **147 cross-directory edges**, of which
**14 pairs import each other**. Meanwhile `apps/web` has used `@/*` since it was
built, so the repository already answered the path question on one side and
never carried it across.

Fourteen mutual dependencies are not a style problem. They are why a directory
cannot be moved without a large, unmechanical edit, and why "which layer owns
this" has no answer — which is the substance of the original complaint that
backend logic is scattered.

## What Changes

- **Write the layout contract into `monorepo-foundation`**, which currently has
  none: the alias convention, the direction rule, and what counts as a
  violation. This is the first change in the programme whose first act is
  writing a rule rather than enforcing one.
- **Adopt `@/*` in `apps/api`**, matching `apps/web`. All 814 `../` imports
  become `@/…`. Every one is exactly one level deep — there are zero `../../`
  imports — so this is a mechanical substitution, not path arithmetic.
- **Break the 9 logic cycles.** Two groups:
  - *Shared symbols living inside feature directories* (7 pairs) move to
    concern-named homes — `decryptStored` to `crypto/`, `AuthenticatedRequest`
    and `isAdminPrincipal` to `http/`, and so on. The name IS the contract, so
    none of these becomes the next `shared/` catch-all.
  - *Two genuine inversions*: `agent-runtime` reaching into `sandbox` for
    `PROVISION_LOOKUP`, and the runtimes reaching into `terminal` for command
    construction — a residual edge pointing the wrong way across the very
    policy/mechanism seam an earlier change established.
- **Permit module composition, forbid logic cycles.** The contract distinguishes
  `*.module.ts` importing another module — normal Nest DI wiring, where a
  blanket ban would be unrealistic and would be worked around — from non-module
  source forming a mutual dependency, which is forbidden. That leaves 5 of the
  14 pairs permitted BY THE CONTRACT rather than by omission, and 9 to break.
- **Gate it**, in the shape the previous three gates established: reviewable
  data, self-testing, CI-wired. No new cycle, and no new `../` import.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `monorepo-foundation`: gains the layout contract it has never had — a path
  alias convention for package-internal imports, and a rule that non-module
  source must not form mutual directory dependencies while `*.module.ts` DI
  composition may. Enforced by an executable check rather than review.

## Impact

- `apps/api/tsconfig.json` — the `@/*` path mapping (and whatever the Nest build
  and the `.mjs` test harnesses need to resolve it)
- `apps/api/src/**` — 814 import statements rewritten mechanically
- New concern-named directories under `apps/api/src` for the extracted shared
  symbols; 7 pairs of feature directories stop reaching into each other
- `apps/api/src/agent-runtime`, `sandbox`, `terminal` — the two inversions
- `scripts/` + `.github/workflows/ci.yml` — the new gate, beside the existing three
- **No product behaviour changes.** Every edit is an import path, a symbol's
  home, or a dependency direction. The full suite plus typecheck is the check,
  and the `.mjs` harnesses that compile real sources are what would catch a
  resolution mistake the type checker misses.
