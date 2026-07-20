# Verification Report — isolate-fixture-git-env

Date: 2026-07-20
Adjudication pass: three-way routing (verify-reopened / spec-defect / met)

## Tally

- Requirements in change: 1
- MET: 1
- UNMET (reopened as code tasks): 0
- SPEC-DEFECT (routed to design.md Open Questions): 0
- Blocking spec defects (public impact / exclusion claims): 0
- Machine-routed public findings: none supplied

## Requirement adjudication

### api-mcp-development-parity/public-surface-suites-are-safe-to-run-from-git-hooks — MET

Independently re-traced end-to-end against the working tree (not taken from the
skeptic/verifier verdict on faith):

- **Scenario: Hook-exported git environment cannot redirect fixture operations** — PASS.
  `scripts/public-surface-adversarial.test.mjs:951` (`fixture repository lifecycle cannot
  touch a bystander repo named by hook env`) builds a bystander repo with one commit,
  poisons `process.env` with `GIT_DIR`/`GIT_INDEX_FILE`/`GIT_WORK_TREE` pointing into it,
  runs the fixture lifecycle, and asserts the bystander's `rev-parse HEAD`,
  `for-each-ref`, and `ls-files -s` outputs are byte-identical before/after
  (lines 984-986). Fixture `runGit` goes through `fixtureGitEnv()`
  (`public-surface-adversarial.test.mjs:367`, `public-surface-tests.test.mjs:278`).
  Suite re-run this pass: 19/19 pass.
- **Scenario: Real-repository collectors resolve from the working directory only** — PASS.
  `gitValues`' spawn in `scripts/public-surface-adversarial.mjs:83` and the pre-push base
  resolution spawn in `scripts/public-surface-pre-push.mjs:38` both pass
  `env: cleanGitEnv()`, which drops every `/^GIT_/` key so the spawned git resolves the
  repository from `cwd` alone; hook-swapped locators cannot redirect it.
- **Scenario: Shared sanitization helper is covered by unit tests** — PASS.
  `scripts/git-env.mjs` exports `cleanGitEnv` (all `GIT_*` keys removed, everything else
  including `PATH` preserved, input not mutated) and `fixtureGitEnv` (adds
  `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`). `scripts/git-env.test.mjs`
  re-run this pass: 4/4 pass, covering GIT_* removal, non-git/`PATH` preservation,
  non-mutation, and the fixture-mode config keys.

Grep audit of `scripts/public-surface-*` confirms every git spawn routes through the
helper (`git-env.mjs` imported and applied in `public-surface-adversarial.mjs`,
`public-surface-adversarial.test.mjs`, `public-surface-tests.mjs`,
`public-surface-tests.test.mjs`, `public-surface-pre-push.mjs`,
`public-surface-hook.mjs`); no remaining git spawn inherits the parent environment.

## Gap findings

Everything checks out. There is only one requirement in this change's specs, and every
scenario under it has a traceable, passing implementation.

```json
[]
```

## Scope findings (implemented behavior beyond the spec text — recorded, non-blocking)

```json
[
  {
    "description": "scripts/public-surface-hook.mjs:115 — runHookPlan strips GIT_* from the env of every hook step's spawned child (pnpm/turbo typecheck, `pnpm test:public-surface`, `node scripts/openspec-metadata.mjs`), none of which are git subprocesses; spec requirement only covers isolating 'git subprocesses spawned by the public-surface verification scripts', not arbitrary non-git children, and no scenario/test asserts this env-stripping",
    "note": "labeled 'Defense in depth' in the code's own comment, confirming it goes beyond the requirement text"
  },
  {
    "description": "scripts/public-surface-tests.mjs:263 — runStep likewise replaces the env passed to every workflow step's spawned process (pnpm/turbo/test-runner invocations) with cleanGitEnv(env), an untested behavior extending the git-subprocess-only requirement to non-git children"
  },
  {
    "description": "scripts/public-surface-pre-push.mjs:86 — the `pnpm verify:public-surface` spawn (not a git subprocess) has its entire env replaced via `{ ...cleanGitEnv(env), CAP_PUBLIC_SURFACE_BASE_SHA: base }`, again applying git-locator sanitization to a non-git child process with no corresponding scenario in specs/api-mcp-development-parity/spec.md"
  }
]
```

Supporting evidence: `openspec/changes/isolate-fixture-git-env/specs/api-mcp-development-parity/spec.md`
and `surface-impact.json:26` both scope the requirement/behavior explicitly to
"git subprocesses" / "every git subprocess ... spawn[ed]" — never to the env of non-git
children (pnpm/turbo/node test-runner steps) that hook/step orchestrators launch.
`tasks.md` task 1.2 also only asks to "route every **git spawn**" through the helper.
The three sites above instead sanitize the env of the *step's own process launch*
(which itself later spawns git, if at all), a broader "defense in depth" measure called
out by its own code comment but not backed by any requirement scenario or
unit/regression test (no test in `public-surface-hook.test.mjs` or
`public-surface-tests.test.mjs` asserts on the env passed to `runHookPlan`/`runStep`'s
`spawnSyncImpl`).

Adjudication of the scope findings: these sites sanitize a superset of what the
requirement demands and cannot violate any scenario (stripping `GIT_*` from a non-git
child's env is behavior-preserving for pnpm/turbo/node, and any git the child later
spawns still benefits). They are extra hardening beyond the spec text, not a
correctness or spec conflict — recorded here, no code task and no design.md Open
Question warranted.

All other diffed behavior (the new `scripts/git-env.mjs` helper and its unit tests,
wiring `fixtureGitEnv`/`cleanGitEnv` into the actual `git` spawns in
`public-surface-adversarial.mjs`, `public-surface-adversarial.test.mjs`,
`public-surface-tests.test.mjs`, `public-surface-pre-push.mjs`'s `gitOutput`, and the
new bystander-repo regression test) maps cleanly to the three scenarios in the
change's spec delta.

## Routing outcome

- reopenedTasks: []
- specDefects: []
- blockingSpecDefects: []
- reclassifiedMet: [] (no raw-unmet finding existed to reclassify; the single
  requirement was already adjudicated MET on first trace)
