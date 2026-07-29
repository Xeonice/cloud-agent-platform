# Pre-change baseline

Working tree at `d3c0b1b` (untracked: `docs/repo-split-epic.md` and this change).
Track 3 compares against every number here.

## Build (task 1.1)
```
turbo run build                     14 tasks, all succeed
turbo run build                     14 tasks, all succeed
@cap/api  test:compiled             1599 run / 1595 pass / 4 skipped / 0 fail
@cap/api  test:src                   300 run /  300 pass / 0 fail
@cap/api  test:suite                  12 run /   11 pass / 1 skipped / 0 fail
@cap/contracts test                  229 run /  229 pass / 0 fail
@cap/web  typecheck, lint           clean
api-module-layout-check             pass (ALLOWED_CYCLES empty)
test-discovery-check                452 files, all mounted
pnpm test:scripts                    214 run / 212 pass / 2 skipped / 0 fail
```

## Exception list — every `cap` that MUST NOT change (task 1.2)

Derived from source, not from memory. Task 3.5 checks against this list.

| identifier | kind | occurrences |
|---|---|---|
| `cap-aio-sandbox`, `cap-aio` | GHCR image / container name prefix | 140 / 103 |
| `cap-api` | GHCR image name | 87 |
| `cap-boxlite`, `cap-boxlite-sandbox` | container name prefix | 82 / 53 |
| `cap-net` | docker network name | 88 |
| `cap-rest` | BoxLite provider mode | 89 |
| `cap_sk_` | credential prefix | 90 |
| `cap_session`, `captmp` | sandbox-side runtime identifiers | 43 / 39 |
| `cap_command_exists`, `cap_release_ok`, `cap_preflight_*` | shell function names | 48 / 41 / 74 |
| `CAP_VERSION`, `CAP_INSTANCE_ID`, `CAP_SECRET_CANARY` | environment variables | — |
| `capability`, `capabilities`, `capacity`, `capture`, `captured` | ordinary English | 598 / 694 / 310 / 195 / 217 |

**None of these contains the substring `@cap/`.** The replacement pattern carried
the leading `@` and the trailing `/`, so it cannot reach any of them. This is why
the substitution is safe to run mechanically rather than reviewed occurrence by
occurrence.

## Archive boundary (task 1.3)

```
openspec/changes/archive/    616 occurrences / 209 files   ← deliberately excluded
```

Per design D2 an archived change records what was true when it was written and is
paired with commits that say `@cap/`. After this change the repository will show
`@cap-console` in `openspec/specs/` and `@cap` in `openspec/changes/archive/`.
**That is correct and must not be "fixed" later.** Task 3.6 asserts the archive
count is still 616.

## Idempotence (task 2.3)

A second pass of the substitution matches **4 files, all of them documents about
the rename itself**:

```
docs/repo-split-epic.md                              1
openspec/changes/.../baseline.md                     7
openspec/changes/.../design.md                      13
openspec/changes/.../proposal.md                     2
```

These are deliberate. A document that says «`@cap/*` becomes `@cap-console/*`»
has to name both scopes; running the substitution over it produced sentences like
«moves from `@cap-console/*` to `@cap-console/*`», which were repaired by hand.

**Zero code or configuration files remain.** The idempotence property holds where
it matters; the exception is exactly the set of files whose subject is the rename.

## boot-smoke attribution (task 3.4)

`scripts/boot-smoke.sh` fails on this machine at the default-admin seed step:

```
boot-smoke: /health healthy — verifying default-admin seed + argon2...
boot-smoke: FAILED — default-admin seed/argon2 reveal did not return a credential (got: {})
```

**Not caused by this change.** Attributed by stashing the rename, reinstalling,
rebuilding the pre-rename api, and running the same script against a fresh
throwaway Postgres — **identical failure**. The same job passes in CI (linux),
so this is a local-environment gap, not a regression.

Two hypotheses were tested and discarded before the attribution run, both by
measurement rather than reasoning:

- *the one-time admin reveal was already consumed by an earlier run* — disproved
  by running once against a genuinely fresh database; same failure.
- *`@node-rs/argon2` native binary missing* (the error message's own suggestion) —
  disproved by loading it directly: `@node-rs+argon2-darwin-arm64@2.0.2` resolves
  and `hash` is a function.

What the run **does** prove for this change: the built application boots and
`/health` returns healthy after the rename, so every module resolved and DI is
intact — which is the property task 3.4 exists to check. The Dockerfile filters
were verified separately (all three `pnpm --filter` targets resolve).

The local boot-smoke gap is out of scope here and is not this change's to fix.
