## Context

Two items, both surfaced by the previous three changes rather than by a survey,
both instances of the pattern this programme keeps finding: a rule was written,
the work it demanded was partly done, and the last step was never taken.

- Four sandbox helper packages were superseded and their code moved, exactly as
  `sandbox-provider-port` requires. The shells were then excluded from
  `pnpm-workspace.yaml` rather than deleted — invisible to the build, still
  visible to every reader and every grep.
- `test-suite-discovery` requires a repository-wide drift check; the
  implementation scoped itself to workspace packages, leaving sixteen root script
  tests that no runner executes.

Constraints:

- Deletion is irreversible in the working tree, so the safety argument has to be
  made from evidence before the delete, not after. It has been: outside their own
  directories and the OpenSpec archives, the only references to the four packages
  anywhere are four `pnpm-workspace.yaml` lines and one README paragraph.
- The sixteen tests all pass today. This change must not become an
  opportunity to "fix" tests that are not broken — anything that turns red on
  mounting is a genuine finding to be investigated, not smoothed over.
- `ci.yml` already names eight script tests individually. Adding sixteen more
  names would be the exact failure mode `test-suite-discovery` exists to prevent.

## Goals / Non-Goals

**Goals**

- The four superseded packages are gone, along with the exclusions and the
  documentation that describes them.
- Every root script test runs, mounted by PATTERN rather than by name.
- The discovery check covers the repository, matching the scope its requirement
  already states, with the exclusion list still empty.
- A non-ASCII checkout path stops breaking the compose test.

**Non-Goals**

- Reviving, refactoring or salvaging anything from the deleted packages. Their
  successors are live and tested; this is removal, not migration.
- Fixing the sixteen tests. They pass. If mounting turns one red, that is a
  finding to report.
- Restructuring `scripts/` or splitting it into packages. Out of scope; the
  directory keeps its shape.
- Touching the provider or runtime axes. Both were just closed.

## Decisions

### D1 — Delete rather than keep excluded

An excluded package is worse than a deleted one: it reads as live code to
anyone browsing or grepping, while being incapable of running. That is not
hypothetical here — the previous change edited one of these files and had to
revert.

*Alternative considered — keep them for reference.* Rejected: git history is the
reference, and it does not mislead readers of the working tree. Nothing is lost
by deleting a directory whose every module has a live counterpart.

*Alternative considered — move them under a `legacy/` directory.* Rejected for
the same reason, with an extra one: it would preserve the ambiguity while adding
a convention nothing else in the repository uses.

### D2 — Mount by pattern, and replace the CI allowlist rather than extend it

One root command discovers `scripts/*.test.mjs` by glob. The eight individually
named CI invocations are replaced by it.

This is the same decision `wire-orphaned-test-suites` made for package suites,
applied to the last directory that still uses the old shape. Extending the CI
list to twenty-four names would leave the twenty-fifth test just as invisible as
the sixteen are now — and the check in D3 would then be enforcing a rule the CI
wiring works against.

**Care required:** some of the eight CI-named tests may be invoked with flags,
env vars, or in specific jobs. Each must be checked before its line is removed;
one that genuinely needs special invocation keeps it and is excluded from the
glob command explicitly, not silently. If any cannot be folded in, that is
recorded rather than worked around.

### D3 — The discovery check covers the repository, not just workspace packages

`listWorkspacePackages()` becomes one source of scannable roots among others,
with the repository's own `scripts/` directory added. The requirement already
says "the repository"; this makes the implementation match rather than changing
what is required.

The exclusion list stays empty. It is worth saying explicitly because the first
entry is how such lists start growing, and the one candidate for an entry — the
Docker-dependent compose test — turned out not to need one (D4).

### D4 — The compose test gets an explicit project name, not a gate

It shells out with `--env-file /dev/null`, which clears `COMPOSE_PROJECT_NAME`;
docker then derives the project name from the working directory and rejects a
non-ASCII one with `project name must not be empty`. It already skips correctly
when Docker is absent, so it is not ungated — it is environment-fragile.

Passing an explicit `-p` fixes it for every checkout path. Worth doing rather
than excluding: an exclusion would hide a test that works, to avoid a problem
that any contributor with a non-ASCII path will hit.

*Recorded because it corrected an earlier reading of mine:* this test was first
reported as "needs a Docker gate". It does not.

## Risks / Trade-offs

- **[Something depends on a deleted package in a way the search missed]** →
  The search covered every file in the repository excluding `node_modules`,
  `.git`, `dist` and `.turbo`, by package NAME (not just import path), which
  catches `package.json` dependencies, Dockerfiles, compose files, CI workflows
  and documentation. The build, typecheck and full test run after deletion are
  the second check: nothing that referenced them could stay green. And since
  turbo does not know these packages, no build output can silently depend on them.
- **[A mounted test is red for a real reason]** → Then it is a finding, and it is
  reported with its output rather than excluded. All sixteen pass standalone
  today, so a red one means the mounting itself changed something — worth
  understanding before proceeding.
- **[Folding a CI-named test into the glob drops a needed flag or env var]** →
  D2 requires checking each of the eight invocations before removing its line.
  Any that cannot be folded in keeps its own step and is stated.
- **[The widened discovery check reports files nobody intends to run]** →
  Possible for `scripts/` helpers that are not tests but match a test suffix. The
  check names every file it reports, so this surfaces as a list to judge, not a
  silent failure. If a file genuinely should not run, that is what the exclusion
  list is for — with a reason.

## Migration Plan

No deployment step, no data migration, no operator-facing change. Nothing
imports the deleted packages, so there is no version skew to manage.

Order: delete the packages first (it is independent and self-verifying via
build + test), then the test mounting, then widen the check — the check is
widened last so it is never knowingly red, the same sequencing the previous two
changes used.

Rollback is a revert.

## Open Questions

- Do any of the eight CI-named script tests require an invocation the glob
  command cannot provide? To be answered by reading each one during
  implementation, not assumed. If some do, they keep their steps and the change
  is smaller than proposed — which is the correct outcome, not a shortfall.
- Does `scripts/` contain files matching a test suffix that are NOT tests? The
  widened check will name them; whether each is an exclusion or a rename is a
  judgement to make with the list in hand.
