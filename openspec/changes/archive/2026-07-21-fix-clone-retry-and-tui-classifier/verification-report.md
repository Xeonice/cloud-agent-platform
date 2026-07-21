# Verification Report — fix-clone-retry-and-tui-classifier

Pass date: 2026-07-21
Verify id: api-mcp
Adjudication: all requirements MET; no verify-reopened tasks; no spec defects; no blocking sidecar defects.

## Three-way tally

| Route | Count | Ids |
| --- | --- | --- |
| Reopened (UNMET) | 0 | — |
| Spec defects | 0 | — |
| Blocking spec defects | 0 | — |
| Reclassified MET | 0 | — (no raw-unmet findings existed to reclassify) |

Raw skeptic unmet findings: none. Machine-routed mandatory public findings: none.

## Requirement adjudications

### agent-runtime/claude-auth-failure-classification-covers-current-cli-phrasings — MET

Fully traceable end-to-end:

- TUI normalization (CUP/HVP + vertical moves -> `\n`, horizontal moves -> space, before generic CSI strip) implemented in `apps/api/src/agent-runtime/runtime-output-failure-classifier.ts`.
- Inline `/login · API Error: 401` line (both `Invalid bearer token` and `OAuth access token is invalid` variants) and the onboarding-wizard dual-anchor match (`Welcome to Claude Code` + `Select login method`) classify `runtime_auth_rejected`.
- The real captured production PTY byte stream is checked in as `apps/api/src/agent-runtime/claude-tui-session.fixture.ts` and exercised both as full input and as an 8 KB rolling tail.
- Narrowness (quoted fragments do not classify) and codex/legacy-claude preservation are covered exhaustively in `apps/api/src/agent-runtime/runtime-output-failure-classifier.spec.ts`.

### sandbox-provider-port/workspace-materialization-reports-bounded-stages-and-typed-failures — MET

Fully traceable end-to-end (inherited baseline from `detach-workspace-clone-change` plus this change's delta):

- Bounded inline-transfer retry loop: `runInlineTransferWithRetries` in `packages/sandbox/src/workspace/git.ts` (~lines 590–651) — max 3 attempts, 5 s backoff, 60 s min-budget floor, retry only `tls_network`/`unknown`, per-attempt observable diagnostics (non-final failure settles `retryable: true`, later attempts mint fresh operation identities), idempotent clean-slate command. Tested in `packages/sandbox/test/staged-workspace-git.test.mjs` (~lines 1567–1761).
- Git stderr signature -> typed-cause mapping: `classifySandboxGitFailure` (same file) maps connection reset/refused/timed-out, unresolvable host, RPC failure, unexpected disconnect, early EOF, transfer-closed -> `tls_network`; filesystem-full -> `capacity_exhausted`; authentication-failed / 401/403 -> `authentication`; unmatched -> `unknown`. Raw output inspected in memory only, never persisted. Tested directly (~lines 1155–1170) and against real captured RPC-failure / early-EOF signatures (~line 1619).
- Detached dual-gate transfer path, stage/diagnostic invariants, and cleanup semantics unchanged from the archived baseline.

## Gap findings

All confirmed traceable, inherited from the prior `detach-workspace-clone-change` and still present.

Both requirements in this change's specs (`agent-runtime/claude-auth-failure-classification-covers-current-cli-phrasings` and `sandbox-provider-port/workspace-materialization-reports-bounded-stages-and-typed-failures`) are fully traceable to implementation — code, fixtures, and tests all exist for every scenario, including the new retry loop (`packages/sandbox/src/workspace/git.ts` lines ~590–651, tested in `packages/sandbox/test/staged-workspace-git.test.mjs` lines ~1567–1761), the git stderr signature mapping (`classifySandboxGitFailure`, same file, tested at lines ~1155–1170 and with real captured RPC/early-EOF signatures at line ~1619), and the TUI normalization + classifier changes (`apps/api/src/agent-runtime/runtime-output-failure-classifier.ts` + `claude-tui-session.fixture.ts`, tested exhaustively in `runtime-output-failure-classifier.spec.ts`).

No unmet gap findings:

```json
[]
```

## Scope findings

Two implementation additions exceed the spec's enumerated signature list. Both are minor, spec-consistent extensions (the requirement mandates the listed signatures map to typed causes; it does not forbid additional stable-signature mappings, and both strings are transient-transport phrasings that correctly belong to `tls_network`). They do not block the primary scenarios and do not constitute public-surface impact (the sidecar's internal-only claim holds — the mappings live entirely inside `packages/sandbox`).

1. `packages/sandbox/src/workspace/git.ts:231` — added git transport signature `operation too slow` -> `tls_network`; not enumerated in `specs/sandbox-provider-port/spec.md`, `design.md` D3, or `tasks.md` 2.1, and has zero test coverage anywhere in the diff. Recommended (non-blocking) follow-up for a future change: add a unit case mirroring the other signature tests.
2. `packages/sandbox/src/workspace/git.ts:232` — added git transport signature `the remote end hung up` -> `tls_network`; not in the spec's signature list ("connection reset/refused/timed-out, unresolvable host, RPC failure, unexpected disconnect, early EOF, and transfer-closed") nor in `design.md` D3 or `tasks.md` 2.1, though it is exercised by one test in `packages/sandbox/test/staged-workspace-git.test.mjs:1748`.

Everything else checked (tasks 1.1/1.2/1.3 TUI normalization + fixture, tasks 2.2/2.3 retry-loop mechanics and diagnostics, task 2.1's other signature mappings, the pre-existing onboarding-wizard classifier logic) maps cleanly to requirement text or scenarios in `specs/agent-runtime/spec.md` / `specs/sandbox-provider-port/spec.md` / `tasks.md` / `design.md`. The two extra signature strings also appear in the `dist/` build artifact (`packages/sandbox/dist/workspace/git.js:122`), which is generated output, not separate scope.

## Sidecar check (surface-impact.json)

`publicV1`/`mcp`/`openapi`/`apiPlayground` declared not-applicable and `internalOnly` declared changed — verified consistent with the actual diff (only `packages/sandbox/src/workspace/git.ts` and `apps/api/src/agent-runtime/*` change; no /v1 operation, schema, error body, MCP tool, or OpenAPI projection is touched). No false protocol exclusions; `protocolDifferences: []` is accurate. Archive is not gated.
