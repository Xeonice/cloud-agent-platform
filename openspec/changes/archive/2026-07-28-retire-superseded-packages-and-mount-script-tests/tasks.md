<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: retire-packages (depends: none)

- [x] 1.1 Re-verified immediately before the delete: for all four, the only out-of-directory hits were the `pnpm-workspace.yaml` exclusion lines and the `@cap/sandbox` README paragraph
- [x] 1.2 Deleted via `git rm` (1,214 lines across four directories)
- [x] 1.3 All four removed — `pnpm-workspace.yaml` now carries a bare `packages/*` with NO exclusions. turbo resolves the same 16 packages before and after, and `pnpm install --frozen-lockfile` succeeded without touching the lockfile, which independently confirms nothing depended on them
- [x] 1.4 Rewritten to state where the code lives and that the superseded packages were removed. Kept the reason in one line — they had been excluded rather than deleted, leaving directories no build could compile that still read as live code
- [x] 1.5 build 14/14, typecheck 23/23, tests 26/26 across three consecutive full runs. One run initially failed at `@cap/sandbox-provider-aio`; investigated rather than assumed — it is the known `aio-terminal-session-ownership.test.mjs` wall-clock flake under parallel load (passes 10/0 standalone, three subsequent full runs green), unrelated to the deletion

## 2. Track: mount-script-tests (depends: none)

- [x] 2.1 Read all eight. They are invoked two ways — seven as `node <file>` (self-executing) and one as `node --test <file>` — and none needs flags, env vars or a specific job. Verified empirically before folding: running all eight under `node --test` gives 28/28. The `bash -n` syntax check on three shell scripts in the same step is unrelated and stays
- [x] 2.2 `pnpm test:scripts` → `node --test --test-force-exit "scripts/*.test.mjs"`. One pattern, no names
- [x] 2.3 All eight folded — none needed keeping. The step is renamed to reflect that it now covers every repository-level test rather than only the release/install contracts
- [x] 2.4 `-p cap-compose-host-bind-test` added, with the reason recorded at the call site. Passes
- [x] 2.5 **The mounting DID surface a real defect, contradicting the brief's prediction.** The glob run went red on three files, not one. Two — `boxlite-real-cli-terminal-canary` and `terminal-fresh-attach-create-cleanup` — died on `Cannot find module '@xterm/headless'`, resolved via `createRequire` from `apps/api`, which does not declare it (only `apps/web` does). `git log -S` dates it exactly: commit **68c0907 removed `@xterm/headless` from `apps/api`'s dependencies in the very same change that introduced the lookup against it**, so these canaries have thrown on import ever since and nothing noticed, because nothing ran them. Fixed by resolving from the declaring package — the repo already had the correct form in `terminal-active-buffer-snapshot.test.mjs`, so this follows it rather than inventing a root dependency. Three sites carried the bug (`terminal-fresh-attach-canary.mjs`, `boxlite-real-cli-terminal-canary.mjs`, `yolo-agent-canary.mjs`). Full glob now 202 tests, 200 pass, 0 fail

## 3. Track: widen-discovery (depends: mount-script-tests)

- [x] 3.1 `REPOSITORY_TEST_DIRS = ['scripts']` plus a second scan pass whose patterns come from the ROOT manifest's test scripts rather than a package manifest. Scanned count 412 → 449
- [x] 3.2 Three cases added (8/8 pass): reported when the root glob would not run it, silent when it would, and — the direction that would otherwise pass silently — a root manifest with NO test script must leave repository-level tests undiscovered rather than treating zero patterns as covering everything
- [x] 3.3 Nothing to judge — the widened check names no file. `scripts/` holds no non-test file matching a test suffix, so `EXCLUSIONS` stays `[]`
- [x] 3.4 Still wired at `ci.yml:189`. Coverage arithmetic is exact: 412 (packages, unchanged) + 37 (`scripts/*.test.mjs`, newly in scope) = 449, so the package-level half was widened, not traded away

## 4. Track: verify (depends: retire-packages, widen-discovery)

- [x] 4.1 All three gates green (discovery now 449 files), each gate's own self-test green (8/7/7), typecheck 23/23, tests 26/26, root script suite 205 tests / 203 pass / 0 fail
- [x] 4.2 Still 16 packages; build 14/14. `pnpm-workspace.yaml` reached this by REMOVING four exclusions rather than adding any, and `--frozen-lockfile` succeeded untouched — nothing depended on the deleted packages
- [x] 4.3 Dropped `scripts/zz-throwaway-orphan.spec.ts` in: the check named it exactly, printed the repository-level branch of the guidance, and exited 1. Removed; back to 449 all-covered
