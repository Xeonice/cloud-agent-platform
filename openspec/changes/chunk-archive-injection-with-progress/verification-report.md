# Verification Report — chunk-archive-injection-with-progress

Date: 2026-07-24 · Pass: opsx-verify three-way routing (re-verify after fix commit `1dbbfbe`)

## Tally

| Route | Count | Ids |
| --- | --- | --- |
| MET (re-traced end-to-end) | 2 | `boxlite-sandbox-provider/boxlite-archive-injection-chunks-uploads-under-the-daemon-body-limit-with-verified-reassembly`, `sandbox-provider-port/archive-workspace-transfer-feeds-the-provisioning-progress-snapshot` |
| UNMET (verify-reopened code task) | 0 | — |
| SPEC-DEFECT (blocking, sidecar) | 0 | — (prior pass's 4 undeclared-impact findings disposed: sidecar corrected in `1dbbfbe`, this pass's public-surface findings empty) |

Archive gate from the prior pass is **cleared**: task V.1 (4.1) is green (verified live this pass) and the surface-impact.json declarations now match code evidence (publicV1/mcp `changed` with tasks.list/tasks.get + list_tasks/get_task, openapi/apiPlayground `derived`, `runtimeWireBehavior: changed`). Machine-routed and mandatory public findings for this pass: both empty.

## Requirement 1 — boxlite-sandbox-provider / BoxLite archive injection chunks uploads under the daemon body limit with verified reassembly

**Verdict: MET.** Independent re-trace this pass confirms a full, traceable implementation end-to-end:

- Implementation: `packages/sandbox-provider-boxlite/src/boxlite-archive-parts.ts` — `splitIntoParts` chunks the tar stream into `partBytes` parts (default 1,572,864 B); `uploadBoxLiteArchiveInParts` uploads ordered `.parts/NNNNNN` files, reassembles via `cat`, verifies byte count (`wc -c`) and SHA-256 against api-side streaming-accumulated values before `tar -xf`, and wipes parts/half-assembled output on any failure.
- Config bounds: `boxlite-config.ts` — `CAP_BOXLITE_ARCHIVE_PART_BYTES` override, default well under the observed 2 MB daemon limit.
- Wiring: `boxlite-provider.ts:1084-1098` (`createArchiveTransferPort` → parts upload instead of single PUT); throws surface as typed `workspace_transfer` failures.
- Tests: `packages/sandbox-provider-boxlite/test/boxlite-archive-parts.test.mjs` — 5 MB payload against a fake 2 MB-limit daemon splits into ordered parts all under the limit, lexicographic-cat reassembly, byte-count + SHA-256 verified before extraction; oversized single upload → typed `part_upload_failed`; forced sha256sum failure → typed `integrity_mismatch`, target wiped, no extraction.
- The prior pass's only note (tasks.md 1.1-1.3 checkbox drift) has been resolved — all track-1 tasks are checked and match the code in commit `1d64a01`.

## Requirement 2 — sandbox-provider-port / Archive workspace transfer feeds the provisioning progress snapshot

**Verdict: MET (reclassified from the prior pass's UNMET).** The prior pass reopened this requirement solely because the mandated unit suite deadlocked — a test-code defect, never a missing-implementation gap. Both halves are now closed:

- Production trace (re-confirmed; unchanged since `1d64a01` — fix commit `1dbbfbe` touched only the spec test and change artifacts): `packages/sandbox/src/workspace/git.ts:717-800` estimates total via disk usage (`estimateRepoStoreCopyBytes`, null on failure), emits per-part `status:'progress'` events with `percent = min(99, floor(uploaded*100/total))` or null when unestimable; `apps/api/src/guardrails/guardrails.service.ts` `buildWorkspaceProgressChain` forwards them when `options.transferProgress` is supplied; the durable admission path supplies `createThrottledTransferProgressWriter` (`apps/api/src/task-admission/transfer-progress-throttle.ts`, ≥1 s interval); `task-admission.worker.ts` checkpoints best-effort without aborting the lease; `PrismaTaskAdmissionStore.checkpoint` (`prisma-task-admission.store.ts`) updates progress columns only for a matching running/leased work row, silently no-op under legacy admission; read projection `task-response.ts` surfaces the fields.
- Test defect fixed and verified live this pass: `apps/api/src/task-admission/transfer-progress-throttle.spec.ts` third subtest now resolves the mock's fresh pending write promise before awaiting (`resolveWrite` invoked after the third report, spec L95-98). `node --test dist/task-admission/transfer-progress-throttle.spec.js` → **pass 3 / fail 0 / cancelled 0** (dist confirmed newer than src). The "in-flight suppresses concurrent reports" assertion semantics are preserved (`writes` still asserted `[1]` then `[1, 3]`).
- Verify-reopened task 4.1 (V.1) is therefore closed as done.

## Blocking spec defects (sidecar)

None this pass. The prior pass's four undeclared-impact findings (apiPlayground/mcp/openapi/publicV1 declarations contradicting code evidence) were disposed via the `1dbbfbe` sidecar correction; the disposition record and original adjudication remain archived in design.md → Open Questions → "【已处置 2026-07-24】Verify-routed spec defects". This pass's machine-routed public findings are empty, confirming the corrected declarations pass the public-surface check.

## Gap findings (unimplemented-requirement sweep)

My independent trace confirms both requirements have full, traceable implementations end-to-end.

```json
[]
```

Both requirements — `boxlite-sandbox-provider: BoxLite archive injection chunks uploads under the daemon body limit with verified reassembly` and `sandbox-provider-port: Archive workspace transfer feeds the provisioning progress snapshot` — trace to concrete code:

- Chunking/reassembly/verification: `packages/sandbox-provider-boxlite/src/boxlite-archive-parts.ts` (split, ordered upload, `cat` reassembly, byte-count+SHA-256 verify, wipe-on-failure), wired via `boxlite-provider.ts:1084-1098` and config bounds in `boxlite-config.ts`.
- Progress feed: `packages/sandbox/src/workspace/git.ts:717-800` (disk-usage estimate, percent capped at 99, null when unestimable), throttled write via `apps/api/src/task-admission/transfer-progress-throttle.ts`, wired through `apps/api/src/guardrails/guardrails.service.ts` and `apps/api/src/task-admission/task-admission.worker.ts`, and persisted (or silently no-op'd for legacy admission with no matching work row) in `apps/api/src/task-admission/prisma-task-admission.store.ts`.

No requirement lacks a traceable implementation. The prior pass's sole reopen reason (the `transfer-progress-throttle.spec.ts` deadlock) was a test defect, not a missing-implementation gap, and is now fixed and green.

## Scope findings (beyond-spec behavior sweep)

```json
[
  {
    "description": "Client-side progress-emission throttle of 500ms in the archive upload callback, a second/different rate-limit value than the spec's '≥1s' snapshot-write throttle — an extra debounce layer not called for by either requirement",
    "file": "packages/sandbox/src/workspace/git.ts:771"
  },
  {
    "description": "Hard min/max bounds (64KB–1.9MB) enforced on the CAP_BOXLITE_ARCHIVE_PART_BYTES override, rejecting out-of-range operator values; the requirement only specifies a default part size and that it be overridable, with no bound-enforcement behavior specified",
    "file": "packages/sandbox-provider-boxlite/src/boxlite-config.ts:31-32"
  },
  {
    "description": "In-flight-write concurrency guard on the throttled progress writer that drops any report arriving while a previous DB write is still pending; the requirement only calls for time-based throttling (one write per second), not suppression of concurrent overlapping writes",
    "file": "apps/api/src/task-admission/transfer-progress-throttle.ts:32-35"
  }
]
```

Note: these are minor, defensible engineering details in service of the existing requirements (staying under the body limit, keeping writes bounded), not independent features. No unrelated features, no dead code paths, and no behavior serving a purpose outside the two specs' stated goals were found. None blocks either requirement's primary scenario.
