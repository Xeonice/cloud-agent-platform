<!-- Track 1 closes the bypass and is the whole point; Track 2 makes the invariant
     assert itself. Track 2's ordering is load-bearing — the api must read the
     identity before the console sends it, and the refusal comes last, or an api
     refuses a field no deployed console sends yet. -->

## 1. Track: one-release-one-console (depends: none)

- [x] 1.1 Record the pre-change baseline so the claim is checkable later: the newest tag, the commit count past it, how many of those touched `apps/web` or `packages/contracts`, and the Vercel production deployment's aliases. Measured today: `v0.46.1`, 19 commits, ≥10 touching those paths, and a production deployment carrying both `cap-console.douglasdong.com` and `cap-web-git-main-…` — the second being what Vercel assigns when production tracks a branch. Written to `baseline.md`, which also records the per-path `buildId()` split that made this invisible.
  - requirements: ["release-and-versioning/a-production-console-shall-only-be-published-by-a-release"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
- [x] 1.2 Turn off the git-driven PRODUCTION deploy for the default branch in `apps/web/vercel.json`, leaving pull-request previews on. A preview is not production and carries no version claim; removing it would cost review value for no safety. `git.deploymentEnabled: { main: false }`. **Checked against Vercel's own documentation rather than assumed**: the field governs deployments "triggered upon commits" and unspecified branches default to `true`, so feature branches still preview and a CLI `deploy --prod` is not a commit trigger and still works — the three properties this task depends on.
  - requirements: ["release-and-versioning/a-production-console-shall-only-be-published-by-a-release"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
- [x] 1.3 Add the console-publish job to `.github/workflows/release.yml`, gated on the image set having verified, passing the resolved release version as `VITE_BUILD_ID`. This is the step that closes the `"dev"` gap on the Vercel path — the same plumbing `release.yml:222` already does for the image, which is why the image path has a real version and the hosted console has never had one. The job also **asserts the version reached the bundle** rather than trusting the deploy's exit code: the defect being fixed is a build that succeeded while the value silently defaulted, so a successful build proves nothing on its own.
  - requirements: ["release-and-versioning/a-github-release-triggered-workflow-publishes-a-matched-versioned-image-set-to-ghcr"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
- [x] 1.4 Make a failed console publish fail the release rather than leave the images published alone. Half a release — images at `vX.Y.Z` and a console still on whatever shipped last — is the exact state this change exists to prevent, so it must not be reachable by a job quietly erroring. **Implementation found a stronger form than the task asked for.** With `deploy-console` merely downstream of `promote-latest`, a console failure still left `latest` already moved onto the new images — anyone pulling `latest` would get new images and the previous console, which IS the split-version state. So `promote-latest` was split into `verify-image-set` and `promote-latest`, and the order is now build → verify → console → move `latest`. A console failure leaves `latest` on the last release, where the images and the console still match. **That split then introduced a regression which is also fixed here**: a skipped dependency skips its dependents, and `deploy-console` is skipped on `workflow_dispatch`, so adding it to the chain would have silently stopped `latest` from ever moving on a dispatch run. `promote-latest` now carries an explicit condition admitting a SKIPPED console but not a FAILED one.
  - requirements: ["release-and-versioning/a-production-console-shall-only-be-published-by-a-release"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
- [x] 1.5 Document the operator's one out-of-repo act: create the Vercel token and project/org ids as repository secrets BEFORE the first release after this lands, or that release publishes no console. **Do not create or store the credential** — write only the workflow that consumes it, and name the secrets it expects. Placed in `release.yml`'s header comment, following the precedent `release-please.yml` already sets for `RELEASE_PLEASE_TOKEN` — including the `gh secret set` lines and where each id comes from. The header also carries that workflow's hard-won lesson forward: it needed a non-`GITHUB_TOKEN` PAT and silently did not fire without one, so the note tells the operator to CONFIRM a production deployment appeared after the first release rather than to read the file and assume.
  - requirements: ["release-and-versioning/a-production-console-shall-only-be-published-by-a-release"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [ ] 1.6 Prove the bypass is closed by OBSERVATION, not by reading config: a commit landing on the default branch produces no production deployment, and a release produces one at that version. The release pipeline has been bitten by exactly this class before — release-please needed a non-`GITHUB_TOKEN` PAT or `release.yml` silently did not fire — so a workflow that looks correct is not evidence that it ran.
  - requirements: ["release-and-versioning/a-production-console-shall-only-be-published-by-a-release"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"

## 2. Track: assert-the-invariant (depends: one-release-one-console)

<!-- Order is the design (D5): read, then send, then refuse. Any other order
     refuses traffic no deployed console can satisfy yet. -->

- [ ] 2.1 Teach the api to READ a console build identity and compare it against its own release version, tolerating absence. Nothing sends it yet, so this step changes no behaviour — which is the point: it is the half that must ship first. **PARTIAL — the contract half is done, the api half is not.** `packages/contracts/src/version.ts` now declares `CONSOLE_BUILD_ID_HEADER`, `CONSOLE_BUILD_ID_SENTINEL`, the four-verdict vocabulary, `compareConsoleBuild()` and `describeConsoleBuildRefusal()`, with 10 cases in `console-build-identity.test.mjs`. Pure and shared on purpose, so the REST guard, the WS connect path and their tests cannot disagree about what a mismatch is. **Two verdicts deliberately do NOT refuse**: `api-unversioned` (a source build reports `unknown`, and refusing every console against it would break `pnpm dev` to enforce an invariant that only means anything between two DEPLOYED artifacts), and `match`. What remains is the api-side guard, scoped to session principals so `/v1` and MCP — reached by credentials that carry no console build — stay exempt. The shared-export gate currently reports these five as reachable only from the package's own tests, which is exactly what they are until 2.2 wires a consumer.
  - requirements: ["release-and-versioning/the-console-shall-present-its-build-identity-and-the-api-shall-refuse-a-mismatch"]
  - surfaces: ["contracts"]
  - verify: "contracts-registry"
- [ ] 2.2 Give `buildId()` its first caller: the console attaches its identity on the REST path and on the WebSocket connect frame. `ConnectAuthFrameSchema` is a non-strict `z.object`, so an api built before 2.1 ignores the added field rather than rejecting the frame — verify that rather than assuming it, since the whole rollout order rests on it.
  - requirements: ["release-and-versioning/the-console-shall-present-its-build-identity-and-the-api-shall-refuse-a-mismatch"]
  - surfaces: ["contracts"]
  - verify: "contracts-registry"
- [ ] 2.3 Flip absence and mismatch to a refusal, naming BOTH versions in the response so an operator can see which side is behind. This is the step that makes the assertion real; leaving it undone leaves a gate that cannot fail, which this repository has now shipped three times and caught three times.
  - requirements: ["release-and-versioning/the-console-shall-present-its-build-identity-and-the-api-shall-refuse-a-mismatch"]
  - surfaces: ["contracts"]
  - verify: "contracts-registry"
- [ ] 2.4 Change the `VITE_BUILD_ID` default so a deployment that did not receive a version cannot look like a laptop build, while a local build still works. `apps/web/Dockerfile:40` currently defaults to `dev`, and the indistinguishability is why the Vercel path stayed unplumbed for its whole life.
  - requirements: ["release-and-versioning/the-web-console-carries-a-baked-build-id"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
- [ ] 2.5 Prove the refusal fires and prove it clears: a console whose identity differs is refused with both versions named; one that matches is served. Verify against a BUILT console rather than a unit double — the defect class here is a build-time value that differs between deployment paths, which no unit test can see.
  - requirements: ["release-and-versioning/the-console-shall-present-its-build-identity-and-the-api-shall-refuse-a-mismatch"]
  - surfaces: ["contracts"]
  - verify: "contracts-registry"
- [ ] 2.6 Confirm the local development loop still works end to end with no release in existence: a locally built console against a locally built api. The sentinel keeps working there by design, and a change that makes `pnpm dev` require a release would be a worse defect than the one being fixed.
  - requirements: ["release-and-versioning/the-web-console-carries-a-baked-build-id"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"

## 3. Track: correct-the-record (depends: none)

- [ ] 3.1 Rewrite `docs/repo-split-epic.md` §4 Phase 2. It states that the "deployed api and deployed web agree" guarantee disappears at the moment of the split; measurement says the guarantee comes from the coordinated RELEASE, not from the monorepo — which is why the compose topology never lost it and the Vercel topology never had it. After the split the umbrella tag (D5) keeps coordinating, so the split does not remove the guarantee either; what removes it is a second deployment path, and that is what this change closes.
  - requirements: ["multi-target-deploy/web-and-api-are-independently-addressable-and-are-not-independently-versioned"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [ ] 3.2 Record in the epic that Phase 2's "what is COMPATIBLE — five inputs from the audit" is SUPERSEDED rather than implemented, and say what happened to each: two were defects and are fixed (`AdminRevealResponse`'s missing absent-arm, the `z.array` vs `{ runtimes }` envelope), and three describe rules for a negotiation this change removes the need for. Two of those three remain worth fixing as code quality and are named as such — the closed-enum `.parse` on responses at `apps/web/src/lib/api/real.ts:1322`, and the vocabulary-erasing `as never` casts (~11 in production files, concentrated in `task-response.ts` and `sandbox-environments.service.ts`) — with the explicit note that they are no longer gate inputs.
  - requirements: ["multi-target-deploy/web-and-api-are-independently-addressable-and-are-not-independently-versioned"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"

## 4. Track: verify (depends: assert-the-invariant, correct-the-record)

- [ ] 4.1 Run the full verification: build, every package suite, typecheck and lint across api/contracts/web, and all repository gates. Compare counts against `83bb319` — api compiled 1599/1595/4, src 293/293, suite 26/25/1, contracts 236/236, web 613 across 82, `test:scripts` 248/246/2 — and account for every difference.
  - requirements: ["release-and-versioning/the-console-shall-present-its-build-identity-and-the-api-shall-refuse-a-mismatch"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [ ] 4.2 State what remains unproven and why. The bypass being closed can only be shown by a real merge and a real release, so 1.6 is a CI observation rather than something closable at a keyboard — the same honest limit the previous change recorded for boot-smoke. Say which of the two observations has happened and which has not.
  - requirements: ["release-and-versioning/a-production-console-shall-only-be-published-by-a-release"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
