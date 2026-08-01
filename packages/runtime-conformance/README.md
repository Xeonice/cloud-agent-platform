# @cap-console/runtime-conformance

The agent-runtime conformance suite (unlock-extension-axes, design D7): one
suite that exercises EVERY declared runtime's behavior contract, so admitting a
new runtime means registering a harness maker and ledger data — never writing
new assertions.

## Layout (go-cloud drivertest)

- **The suite owns every scenario assertion** — `src/scenarios/*` hold the five
  families; nothing else may assert.
- **A runtime participates through a harness maker only** — construction +
  environment hooks (fixture material, launch expectations, credential stubs),
  see `src/harness.ts` and the per-runtime entry points in `src/runtimes/*`.
  The seam is typed as construction + hooks: no member accepts or returns a
  test assertion, so a runtime physically cannot fork scenario logic.
- **Participation is a compile-time ledger** — a pair of total Records
  (structurally copied from `packages/sandbox-conformance/src/required-participation.ts`):
  the runtime-keyed harness ledger (`src/registry.ts`) and the family-keyed
  obligation table (`src/participation.ts`). The families a runtime MUST run
  derive from its declared `executionModes` (declaring `headless-exec` obliges
  the headless family). A declared runtime with no ledger entry fails
  TYPECHECK — the self-invalidating guards live in
  `src/runtime-participation.typecheck.ts`.

## Five scenario families — ported, not invented

| Family | Seed (assertions ported from) |
| --- | --- |
| launch | `apps/api/src/agent-runtime/codex-launch.test.mjs` (byte-exact golden detached launch line) + `agent-runtime.test.mjs` |
| lifecycle | `agent-runtime.test.mjs` (DSR/quiesce startup policy, `tmux has-session` exit detection) |
| transcript | `apps/api/src/sandbox/{claude-transcript-parser,rollout-parser}.test.mjs` + the artifact declarations in `headless-execution.spec.ts` |
| headless | `apps/api/src/agent-runtime/headless-execution.spec.ts` (argv assertion vocabulary; the live-tmux boundary capture stays with the api seed) |
| secret-canary | `packages/sandbox-conformance/src/workspace-git-conformance.ts` (canary / exactly-once / zero-leak vocabulary) applied to the runtime credential seams |

The codex golden launch fixture and the transcript fixtures are MOVED
byte-identical from their seeds (provenance noted at each fixture). The seeds
in `apps/api` are unchanged; extraction runs api→package only — this package's
compile graph carries no `apps/api` import (`pnpm typecheck` proves it). The
runtimes themselves still live in `apps/api`, so the TEST-runtime bridge
(`test/support/api-runtime-seed-bridge.mjs`) compiles the real leaf sources the
same way the repo's `.test.mjs` harnesses do and injects the constructors
through the typed `RuntimeSeedBridge` seam.

## Report artifact

Every suite run writes `reports/runtime-conformance-report.json`: one row per
(declared runtime × family), each `pass` or `skip` **with a reason**. A family
skipped because the runtime does not declare the implying execution mode is an
explicit reasoned skip row, never silence.

## CI enrollment — by directory discovery, zero workflow edits

Confirmed before wiring (unlock-extension-axes task 5.1): the `package-suites`
job in `.github/workflows/ci.yml` runs
`pnpm turbo test --filter='./packages/*' --continue` behind a directory filter
that is documented in-place as deliberate: *"a new package that declares a
`test` script joins this lane automatically."* This package sits in
`packages/*` and declares `test`, so it is enrolled with **zero workflow-file
edits** and **no frozen CI check display name changes** (the lane keeps its
existing `package suites` name).

The new coverage starts **non-required**: `package suites` gates what branch
protection already says it gates; adding this package widens the lane's
content, not the required-check set. Registered follow-up (manual GitHub step,
deliberately outside this change): if operators later want a dedicated
required check for runtime conformance, that is a branch-protection edit made
in the same change that splits the lane — never a silent workflow rename.
