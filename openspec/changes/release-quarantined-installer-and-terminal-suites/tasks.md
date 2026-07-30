## 1. Track: diagnose (depends: none)

- [ ] 1.1 Make `scripts/install-preflight.test.mjs` report why a case failed — at minimum the script's exit status, stderr, and the fake-binary log — because its current `PASS`/`FAIL` output is what turned four investigations into four rejected hypotheses and no answer.
  - requirements: ["test-suite-discovery/a-suite-excluded-from-execution-shall-name-an-accountable-change"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [ ] 1.2 With diagnostics in place, obtain the failure detail from the GitHub runner. Local environments do not reproduce it: 48/48 pass on macOS, in `node:22-slim` with curl, and in that container with tools planted in `/usr/local/bin`.
  - requirements: ["test-suite-discovery/a-suite-excluded-from-execution-shall-name-an-accountable-change"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [ ] 1.3 Establish whether `aio-terminal-pair-stale-sweep-canary` shares a cause with install-preflight. They have failed together in every observed run and neither has failed alone, which is either one cause or a coincidence worth disproving.
  - requirements: ["test-suite-discovery/a-suite-excluded-from-execution-shall-name-an-accountable-change"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [ ] 1.4 Read what `flushCast` awaits in `readoption-history.test.mjs` and determine whether the intermittent single-event observation is a race in the code under test or an assertion on timing the test does not control.
  - requirements: ["test-suite-discovery/a-suite-excluded-from-execution-shall-name-an-accountable-change"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"

## 2. Track: release (depends: diagnose)

- [ ] 2.1 Fix or explain each suite, and remove its entry from `scripts/quarantined-suites.mjs`. A suite that should not exist is deleted with that stated as the reason, never by attrition.
  - requirements: ["test-suite-discovery/a-suite-excluded-from-execution-shall-name-an-accountable-change"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [ ] 2.2 Prove each released suite on the GitHub runner, not locally. All three pass locally today; that is why they were quarantined rather than fixed.
  - requirements: ["test-suite-discovery/a-suite-excluded-from-execution-shall-name-an-accountable-change"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [ ] 2.3 Confirm the quarantine list is empty and that `scripts/quarantined-suites.test.mjs` still passes with it empty — the mechanism must survive its own disuse.
  - requirements: ["test-suite-discovery/a-suite-excluded-from-execution-shall-name-an-accountable-change"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
