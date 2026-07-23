# Verification Report — chunk-archive-injection-with-progress

Date: 2026-07-24 · Pass: opsx-verify three-way routing (post-skeptic adjudication)

## Tally

| Route | Count | Ids |
| --- | --- | --- |
| MET (reclassified after re-trace) | 1 | `boxlite-sandbox-provider/boxlite-archive-injection-chunks-uploads-under-the-daemon-body-limit-with-verified-reassembly` |
| UNMET (verify-reopened code task) | 1 | `sandbox-provider-port/archive-workspace-transfer-feeds-the-provisioning-progress-snapshot` (test-only defect, task V.1) |
| SPEC-DEFECT (blocking, sidecar) | 2 | both requirement ids (4 undeclared-impact findings against surface-impact.json — see design.md Open Questions) |

Archive is **gated** until the surface-impact.json declarations are corrected (blocking spec defects) and task V.1 is green.

## Requirement 1 — boxlite-sandbox-provider / BoxLite archive injection chunks uploads under the daemon body limit with verified reassembly

**Verdict: MET at code level (reclassified).** The skeptic's `refuted` flag stems solely from the sidecar declaration mismatch (routed as blocking spec defect), not from any code-level failure. Re-trace, re-run this pass:

- Implementation: `packages/sandbox-provider-boxlite/src/boxlite-archive-parts.ts` — `splitIntoParts` (L84-108) chunks the tar stream into `partBytes` parts (default 1,572,864 B); `uploadBoxLiteArchiveInParts` (L127-224) uploads ordered `.parts/NNNNNN` files, reassembles via `cat .parts/* > .cap-archive.tar && rm -rf .parts`, verifies `wc -c` and `sha256sum` against api-side streaming-accumulated values before `tar -xf`, and wipes parts/half-assembled output on any `BoxLiteArchivePartsError`.
- Config bounds: `boxlite-config.ts` L30-32/179-184 — `CAP_BOXLITE_ARCHIVE_PART_BYTES` override clamped to [64 KiB, 1,900,000 B], under the observed 2 MB daemon limit.
- Wiring: `boxlite-provider.ts:1084-1098` (`createArchiveTransferPort` → parts upload instead of single PUT); `packages/sandbox/src/workspace/git.ts:717-801` tags the step `stage:'workspace_transfer'` and any throw becomes a typed `failed('workspace_transfer', …)` outcome surfaced as `SandboxWorkspaceMaterializationError`.
- Tests: `packages/sandbox-provider-boxlite/test/boxlite-archive-parts.test.mjs` (wired into package `test`/`coverage` scripts) — 5 MB payload against a fake 2 MB-limit daemon splits into 4 ordered parts all under the limit, lexicographic-cat reassembly, byte-count + SHA-256 verified before extraction; oversized single upload → typed `part_upload_failed`; forced sha256sum failure → typed `integrity_mismatch`, target wiped, no extraction. **Re-run 2026-07-24: `node test/boxlite-archive-parts.test.mjs` → 15 assertions passed.**
- Minor gap not blocking the primary scenario: tasks.md checkboxes 1.1-1.3 remain unchecked despite the code being live in commit `1d64a01` — bookkeeping drift, not an implementation gap.

## Requirement 2 — sandbox-provider-port / Archive workspace transfer feeds the provisioning progress snapshot

**Verdict: UNMET (reopened as task V.1) — production path traces end-to-end, but the mandated unit test deadlocks.**

Code-level trace (all confirmed): `git.ts:717-800` estimates total via `estimateRepoStoreCopyBytes` (null on failure), emits per-part `status:'progress'` events with `percent = min(99, floor(uploaded*100/total))` or null when unestimable; `guardrails.service.ts` `buildWorkspaceProgressChain` forwards them only when `options.transferProgress` is supplied; the durable admission path supplies `createThrottledTransferProgressWriter` (`transfer-progress-throttle.ts`, ≥1 s interval); `task-admission.worker.ts:538-555` checkpoints best-effort without aborting the lease; `PrismaTaskAdmissionStore.checkpoint` updates progress columns only for a matching running/leased `task_admission_work` row, silently affecting 0 rows under legacy admission; the legacy call site structurally omits `transferProgress`. Read projection `task-response.ts:205-224` already surfaces the fields.

Blocking defect (verified live this pass): `apps/api/src/task-admission/transfer-progress-throttle.spec.ts` subtest 3 ("a slow in-flight write suppresses concurrent reports instead of stacking") deadlocks — the final `await writer(… snapshot(3))` (spec L93) awaits a fresh mock promise whose `resolveWrite` is never invoked. `node --test dist/task-admission/transfer-progress-throttle.spec.js` → pass 2 / **cancelled 1** (`Promise resolution is still pending but the event loop has already resolved`). The production throttle logic is correct by inspection and by the two passing subtests, but task 2.2's required progress unit suite is not green, so the requirement cannot be certified MET. Reopened as **Track: verify-reopened, task V.1**.

## Blocking spec defects (sidecar)

Four undeclared-impact findings (apiPlayground `not-applicable`, mcp `unchanged`, openapi `not-applicable`, publicV1 `unchanged` — each contradicted by code evidence per the public-surface check) apply to both requirement ids. Archive cannot accept a false sidecar claim; details and required corrections are recorded in design.md → Open Questions → "Verify-routed spec defects".

## Gap findings (unimplemented-requirement sweep)

This confirms full wiring exists across the stack. Both requirements have traceable implementations end-to-end (chunking/reassembly/verification in boxlite-archive-parts.ts, and progress feed in git.ts + guardrails.service.ts snapshot writer). No requirement is entirely unimplemented.

Based on the investigation, there are no requirements with zero traceable implementation. Returning empty array:

```json
[]
```

## Scope findings (beyond-spec behavior sweep)

Based on a full review of the `chunk-archive-injection-with-progress` change (specs, tasks, design, and the implementing commit `1d64a01`), the implementation is unusually tightly scoped to its two specs. Nearly every line traces to a task/requirement. Only a few minor behaviors go beyond the literal spec text:

```json
[
  {
    "description": "A second, undocumented 500ms client-side progress-emission throttle (distinct value from the spec's '≥1s' write throttle) gates how often onBytesUploaded even attempts to report progress, on top of the DB-level 1s throttle",
    "file": "packages/sandbox/src/workspace/git.ts:771"
  },
  {
    "description": "Hard min/max bounds (64KB–1.9MB) on CAP_BOXLITE_ARCHIVE_PART_BYTES that reject out-of-range operator overrides; the requirement only specifies a default and that it is overridable, with no bound enforcement",
    "file": "packages/sandbox-provider-boxlite/src/boxlite-config.ts:31-32"
  },
  {
    "description": "An in-flight-write concurrency guard (drops any progress report that arrives while a previous DB write is still pending) added to the throttled writer; the requirement only calls for time-based throttling to one write per second, not suppression of concurrent overlapping writes",
    "file": "apps/api/src/task-admission/transfer-progress-throttle.ts:32-35"
  }
]
```

Note: these are minor, defensible engineering details in service of the existing requirements (staying under the body limit, keeping writes bounded), not independent features. No unrelated features, no unused/dead code paths, and no behavior serving a purpose outside the two specs' stated goals were found.
