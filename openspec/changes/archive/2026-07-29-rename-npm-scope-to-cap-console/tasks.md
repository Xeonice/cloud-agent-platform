<!-- The rename is mechanical and must land as one coherent state: intermediate
     per-package commits leave a workspace that does not resolve. Tracks 1 and 3
     are the judgement; Track 2 is the substitution. -->

## 1. Track: boundary (depends: none)

- [x] 1.1 Record the pre-change baseline: full build, the three api suites, the contracts suite, web typecheck, and the repository gates. This is what "unchanged" is measured against.
- [x] 1.2 Enumerate the exception list from source — every occurrence of `cap` that MUST NOT change (GHCR image names, `CAP_VERSION`, compose service names, container names, the `cap-net` network, `name=cap-aio-` filters). Record it; Track 3 checks against this list, not against memory.
- [x] 1.3 Confirm the archive boundary: count occurrences under `openspec/changes/archive/` and record that they are deliberately excluded per design D2, so a later reader does not "fix" the inconsistency.

## 2. Track: substitution (depends: boundary)

- [x] 2.1 Replace `@cap-console/` with `@cap-console/` across sources, configs, workflows, the Dockerfile, shell scripts, current specs, and in-flight changes — excluding `openspec/changes/archive/` and everything on the 1.2 exception list.
- [x] 2.2 Regenerate `pnpm-lock.yaml` via `pnpm install` rather than editing it (design D3).
- [x] 2.3 Prove idempotence: run the same replacement a second time and confirm it produces no diff. A second-pass diff means the pattern is catching something it should not.
- [x] 2.4 Confirm no exact-name turbo filter became a glob (design D4): review the two workflow files and the Dockerfile, and confirm every `--filter` argument keeps its original form with only the scope substituted.

## 3. Track: verification (depends: substitution)

- [x] 3.1 Run the full build. A green typecheck is explicitly insufficient — the build is what exercises the turbo filters the rename touched.
- [x] 3.2 Run typecheck and lint for api, contracts, and web; run the three api suites and the contracts suite. Counts must match the 1.1 baseline exactly.
- [x] 3.3 Run the repository gates: module layout, test discovery, and the script suite.
- [x] 3.4 Exercise the paths no typecheck reads: the boot-smoke script, and a `docker build` of `apps/web/Dockerfile` far enough to prove its filters resolve.
- [x] 3.5 Check the exception list from 1.2 survived: every image name, environment variable, and compose service that contains `cap` is byte-identical to before.
- [x] 3.6 Confirm zero `@cap-console/` occurrences remain outside `openspec/changes/archive/`, and that the archive count is unchanged from 1.3.
