## Context

Measured on the working tree at `d3c0b1b`:

```
代码 + 配置      1,597 处 / 606 文件
当前 specs          73 处 /  16 文件
在途 changes        27 处
归档 changes       616 处 / 209 文件
```

The scope `@cap-console` is registered and ownership verified. The verification
method matters, because the obvious ones do not work:

```
npm org ls cap          → cap - owner          ← 占位响应
npm org ls angular      → angular - owner      ← 已知不属于本账号，输出相同
npm team ls <any>       → E404                 ← 包括自己的 user scope
```

Only the member-scoped form discriminates:

```
npm org ls cap-console douglasdong → douglasdong - owner
npm org ls cap         douglasdong → (空)
npm org ls angular     douglasdong → (空)
```

Constraints:

- The rename reaches build filters (`turbo --filter @cap/api`), a Dockerfile, and
  shell scripts. **None of those is read by `tsc`**, so a green typecheck proves
  very little here.
- `pnpm-lock.yaml` contains the names; it must be regenerated rather than edited.
- The repository is mid-programme: `openspec/changes/archive/` holds 209 files
  that name the old scope as a matter of historical record.

## Goals / Non-Goals

**Goals:**

- One scope, project-owned, across all sixteen packages.
- Zero runtime behaviour change; zero product-surface change.
- Verification that actually exercises the paths a typecheck cannot see.

**Non-Goals:**

- Publishing. Renaming and publishing are separate acts with separate risks.
- Any repository restructuring.
- Renaming GHCR images or compose services that contain `cap`.

## Decisions

### D1 — One scope for all sixteen, not just the one that gets published

Only `contracts` will ever be published, so only it strictly needs an owned name.
The other fifteen could have kept `@cap/*` indefinitely.

They will not, because the resulting repository would carry two scopes with
nothing in the source distinguishing them. A reader — or an agent — encountering
`@cap/ui` and `@cap-console/contracts` has no way to know that one of those is a
registry name and the other is a local fiction, and the rule that decides which is
which lives nowhere in the code.

*Alternative rejected — rename only `contracts`.* Cheaper by roughly 1,000
occurrences, and it introduces a distinction that is invisible at every call site.

### D2 — Current specs are renamed; recorded changes are not

A capability spec states what the system is now, so it follows the rename. An
archived change states what was done at a point in time and is paired with commits
that say `@cap/*`; rewriting it would make the record disagree with the history it
documents.

This produces a repository where `openspec/specs/` says `@cap-console` and
`openspec/changes/archive/` says `@cap`. That is correct, and the difference is
legible from the directory name.

*Alternative rejected — rewrite archives for consistency.* Consistency of a record
with itself matters less than consistency of a record with what happened.

**Corrected during implementation: in-flight changes are records too.** The first
draft renamed everything under `openspec/changes/` except the archive, on the
reasoning that a change applied later should inherit the new scope. Running it
showed what those 27 occurrences actually are:

```
harden-scheduled-task-dispatch   | `pnpm --filter @cap/api test` | PASS: 584 compiled tests… |
use-local-account-quick-deploy   - [x] 3.3 Run `pnpm --filter @cap/www typecheck`.
```

Completed task checkboxes and captured verification output — records of commands
that were actually run, under the name they were actually run with. Rewriting them
falsifies the record for the same reason rewriting an archive does, so the rule is
not "archives are excluded" but **"records are excluded"**, and an in-flight
change is a record of everything already done in it.

The stated benefit — later changes inheriting the new scope — survives without the
rewrite, because a stale filter fails loudly: `turbo --filter @cap/api` reports
`No package found` and exits 1 (measured in D4). An implementer hits it
immediately rather than shipping a silent mismatch.

There was a second, unanticipated cost. `scripts/openspec-metadata.mjs` validates
**changes touched by the diff**, deliberately so that legacy non-compliant changes
do not block unrelated work. Renaming inside five in-flight changes pulled all
five into that gate and failed the commit on metadata they never had — dragging
other people's unfinished work into a standard it was exempt from, for a benefit
that did not need the rewrite.

### D3 — The lockfile is regenerated, never edited

`pnpm-lock.yaml` names every workspace package. Hand-editing it produces a file
that parses but may not match what a fresh resolution would produce. The rename
edits `package.json` files and then runs `pnpm install` to regenerate.

### D4 — Acceptance requires a build and a boot, not a typecheck

The rename touches three classes of file that `tsc` never reads:

| file | what breaks if the rename misses it |
|---|---|
| `.github/workflows/{ci,release}.yml` | `turbo --filter` arguments |
| `apps/web/Dockerfile` | build-stage filters; fails only when an image is built |
| `scripts/{boot-smoke,scheduled-tasks-live-e2e}.sh` | package names; fails at run time |

**A first draft of this decision claimed that a turbo filter matching nothing
passes silently, and used that to justify counting tasks rather than exit codes.
That was wrong, and measuring it changed the conclusion:**

```
$ turbo run build --filter @cap-console/api        # 精确名，零匹配
x No package found with name '@cap-console/api' in workspace
exit 1

$ turbo run build --filter "@cap-console/*"        # 通配，零匹配
Cached: 0 cached, 0 total
exit 0
```

An **exact-name** filter fails loudly; a **glob** filter succeeds while doing
nothing. Every filter in this repository that contained `@cap/` was an exact name
(`--filter @cap/api`, `@cap/web`, `@cap/contracts`, `@cap/sandbox`, `@cap/ui`).
The globs in use are path-based (`--filter './apps/*'`) and contain no scope at
all, so the rename cannot reach them.

So the silent-no-op hazard is **not present here** — a missed rename in a workflow
filter stops CI with a named error. Two consequences:

1. Acceptance does not need task-count assertions; exit codes suffice for the
   filters.
2. It **must not** convert any exact-name filter into a glob while renaming. That
   single edit would trade a loud failure for a silent one.

The Dockerfile and the shell scripts remain outside any typecheck, so acceptance
still requires a full build plus the boot-smoke path.

### D5 — Mechanical, in one pass, verified as a whole

The replacement is `@cap/` → `@cap-console/` with no exceptions inside the renamed
scope, applied by script rather than by hand across 606 files. Splitting it into
per-package commits would leave intermediate states where the workspace does not
resolve, and would not make review easier — the diff is uniform by construction.

Review effort goes into the **exception list** (what must NOT change: GHCR image
names, `CAP_VERSION`, compose services, archives) rather than into reading 1,597
identical substitutions.

## Risks / Trade-offs

- **[Converting an exact-name filter to a glob while renaming]** → The only way
  to introduce a silent no-op here (D4). The rename is a literal substring
  substitution and does not change filter form; a review pass over the two
  workflow files confirms it.

- **[A literal substring replacement misses escaped forms]** → **This happened.**
  Eight occurrences lived inside regex literals as `@cap\/…` — an escaped slash,
  so the text contained `@cap\/` and not `@cap/`. All eight were in gates that
  assert on package boundaries or workflow contents
  (`sandbox-package-boundary`, `sandbox-host-harness-wiring`,
  `sandbox-environment/package-boundary`, `scheduled-tasks-live-e2e`,
  `task-admission-migration-workflow`), so missing them would have left those gates
  asserting against a name that no longer exists. Caught by task 3.2's rule that
  suite counts must match the baseline exactly — the compiled suite had dropped
  from 1599 to 1590. A grep for the escaped form is now part of task 3.6.

- **[The replacement catches strings that merely start with `@cap`]** → The
  pattern is `@cap/` with the trailing slash, so `@cap-console/` (already renamed)
  and `cap-api` (an image name) do not match. Idempotence is checked: running the
  replacement twice must produce no second diff.

- **[Archived changes drift from the specs they were archived against]** → D2,
  deliberate. Recorded so a future reader does not "fix" it.

- **[The rename collides with concurrent work]** → 8 active changes exist in
  `openspec/changes/`, and 27 occurrences of `@cap/` live in them. They are
  renamed with the rest; any change applied after this one inherits the new scope
  naturally.

## Migration Plan

None for deployments. No image, environment variable, database, or wire-format
changes. A running deployment is unaffected — the scope exists only at build time.

Rollback is a revert plus `pnpm install`.

## Open Questions

None. The scope is registered and verified; the exception list is enumerated in
the proposal's Impact section.
