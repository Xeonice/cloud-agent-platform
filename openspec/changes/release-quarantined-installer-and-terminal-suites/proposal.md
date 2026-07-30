## Why

Three suites do not run. They are listed in `scripts/quarantined-suites.mjs`, and
this change is the entry each of them names as accountable for its removal.

They were quarantined to unblock a merge, which is a decision with a short shelf
life: a skip list is only distinguishable from the one this programme abolished
for as long as someone is obliged to empty it. That obligation is this change.

| suite | what is known |
|---|---|
| `scripts/install-preflight.test.mjs` | 17 of 48 cases fail on the GitHub runner, all in paths where the installer installs something. Passes 48/48 on macOS, in `node:22-slim` with curl, and in that container with tools planted in `/usr/local/bin`. |
| `scripts/aio-terminal-pair-stale-sweep-canary.test.mjs` | Fails on the runner in 3 of 4 observed runs, always alongside install-preflight and never without it. |
| `apps/api/src/terminal/readoption-history.test.mjs` | One case intermittently sees one cast event where two were written. 1 of 4 runs; passes 5/5 and 6/6 standalone on both platforms and inside the full suite. |

The first two were mounted by `43aca22` and are absent from `main`, so CI is the
first environment that has ever run them. The third runs on `main` too, so its
flakiness predates this work.

## What Changes

- **The first two are diagnosed on the runner, not guessed at.** Four hypotheses
  were tested and rejected already (platform, missing curl, Homebrew probing of
  `/usr/local/bin`, a CI-specific branch — the scripts contain none). What remains
  needs the failing environment, either by making the suite report why a case
  failed or by reproducing on the runner image.
- **`install-preflight.test.mjs` learns to say what failed.** It prints `PASS`/`FAIL`
  and nothing else, so its 17 failures carry no diagnostic at all. That is why
  four rounds of investigation produced four rejected hypotheses and no answer.
- **The third is either stabilised or explained.** A test that fails once in four
  CI runs and never locally is either racing on something real or asserting on
  timing it does not control; both are answerable by reading what `flushCast`
  actually waits for.
- **The quarantine list returns to empty.** Every entry leaves, or its entry is
  rewritten to say why the suite should not exist.

## Capabilities

### Modified Capabilities

- `test-suite-discovery`: the contract that every test file is executed by a
  runner gains its missing half — that a suite may be excluded from execution
  only while an accountable change exists to return it.

## Impact

**Code** — `scripts/install-preflight.test.mjs` (diagnostics, then the fix),
`scripts/aio-terminal-pair-stale-sweep-canary.test.mjs`,
`apps/api/src/terminal/readoption-history.test.mjs`, and
`scripts/quarantined-suites.mjs` as each entry leaves.

**Verification** — a released suite must pass on the GitHub runner, not only
locally. Every one of these passes locally today; that is precisely why they were
quarantined rather than fixed.

**Non-Goals**

1. Deleting a suite to empty the list. A suite that should not exist is removed
   with that stated as the reason, not by attrition.
2. Loosening an assertion so a case passes. The three assertions in question have
   not been shown to be wrong.
