# Third-runtime admission drill (integration tasks 7.6 / 7.7)

Measured on the fully merged working tree (all six parallel tracks + integration
tasks 7.1–7.5 applied), 2026-08-01. Method reused from the
`2026-07-29-derive-runtime-vocabulary-from-registration` baseline: add a
throwaway runtime identifier (`opencode`), record verbatim what the compiler
demands, revert everything.

## Historical anchor

`openspec/changes/archive/2026-06-18-add-claude-code-runtime` — admitting the
SECOND runtime was a whole change: port extraction, per-runtime branches edited
across the api and the console, hand-maintained vocabulary statements in four
places. The derive-runtime change (2026-07-29) collapsed the vocabulary to one
declaration + one registration but left policy data spread across ternaries and
local copy tables. This change's promise: after unlock-extension-axes, a third
runtime costs **one declaration + one registration**, and every remaining
compiler demand is a ROW OF TABLE DATA — never a new display branch, never a
dispatch edit, never a second vocabulary statement.

## Step 1 — the declaration alone

`packages/contracts/src/agent-runtime-id.ts:24`:

```ts
export const AGENT_RUNTIME_IDS = ['claude-code', 'codex', 'opencode'] as const;
```

`pnpm --filter @cap-console/contracts typecheck` demands exactly one data fill,
reported at the table and again by its self-invalidating totality fixture:

```
src/agent-runtime-id.ts(134,12): error TS1360: Type '{ ... }' does not satisfy
  the expected type 'Record<"claude-code" | "codex" | "opencode", RuntimeMetadata>'.
src/runtime-metadata.typecheck.ts(33,7): error TS2741: Property 'opencode' is
  missing in type '{ ... }' but required in type
  'Readonly<Record<"claude-code" | "codex" | "opencode", RuntimeMetadata>>'.
```

→ **1 demanded edit: the `RUNTIME_METADATA` row** (label / hint /
cliPreviewComment / credential copy / credentialModes — pure data). A throwaway
row was filled and contracts rebuilt so the consumers could be measured.

## Step 2 — declaration + registration, downstream demands

With the contracts dist rebuilt, `@cap-console/api` typecheck demanded the
registration first:

```
src/agent-runtime/agent-runtime.integration.ts(162,7): Property 'opencode' is
  missing in type '{ codex: CodexRuntime; 'claude-code': ClaudeCodeRuntime; }'
```

The drill registration was added (`opencode: new CodexRuntime()` — a typecheck
stand-in, never run). The COMPLETE residual demand list across every workspace
package, verbatim locations, every one a `Property 'opencode' is missing` in a
total `Record`:

| # | file | line | table row demanded |
|---|---|---|---|
| 1 | api `agent-runtime/runtime-model-rejection-evidence.ts` | 37, 47 | CLI version pin |
| 2 | api `agent-runtime/runtime-model-rejection-evidence.spec.ts` | 36 | its fixture |
| 3 | api `runtime-models/prisma-runtime-model-credential.resolver.ts` | 44 | credential resolution |
| 4 | api `runtime-models/runtime-model-catalog.port.ts` | 118 | catalog adapter descriptor |
| 5 | api `runtimes/runtimes.service.ts` | 67 | readiness policy |
| 6 | api `sandbox-environments/sandbox-environments.validator.ts` | 474 | probe name / executable |
| 7 | ~~web `lib/runtime-label.ts`~~ | — | ~~display label~~ 已消除（verify 重开任务 9.8：label 改读 `RUNTIME_METADATA[runtime].label`，第三 runtime 的 label 随 metadata 行自动到达，本文件零改动） |
| 8 | web `routes/_app/settings.tsx` | 213 | credential-group wiring (collection-driven settings) |
| 9 | runtime-conformance `registry.ts` | 17 | harness-maker ledger row (participation) |

## Step 3 — the claim, judged

- **Zero further vocabulary statements.** The predecessor drill found 4 (later
  5, later 7) hand-kept spellings of the runtime set. This drill found **none**:
  every demand above is keyed BY the one declaration, not a restatement of it.
- **Zero display or dispatch branches.** The pre-change failure mode — editing
  `new-task-dialog.tsx` copy tables, `runtime-credential-alert.tsx` hardcoded
  branches, `task-failure.ts` label ternaries, the transcript-read inline
  check — appears NOWHERE in the demand list. The dialog, the credential alert,
  and the CLI preview are driven by the `RUNTIME_METADATA` row from step 1; the
  transcript seam demanded nothing because a new runtime DECLARES one of the
  shape-named strategies on its own `AgentRuntime` (the drill stand-in reused
  codex's), and the facade dispatch is already total over that vocabulary.
- **The conformance suite recruits by ledger, not by edit.** Demand #9 is the
  participation ledger doing its job: one harness-maker entry admits the runtime
  to every scenario family its declared execution modes owe; no scenario file is
  touched.
- **Every demand is a row someone must genuinely decide** (which CLI version to
  pin, how credentials resolve, what the probe runs, what the label says). The
  total-mapping pattern is right to force these; none of them is accidental
  complexity.

Admission cost, summarized:

| | 2026-06-18 (2nd runtime) | 2026-07-29 (post derive-runtime) | now |
|---|---|---|---|
| vocabulary statements | 4+, hand-kept | 1 | **1** |
| registration | not checked | compile-enforced | compile-enforced |
| display/dispatch branches to edit | many (console + api) | 2 rebuilt tables + ternaries remained | **0** |
| residual demands | — | 7 policy tables | **9 table rows** (7 api/web policy + settings wiring + conformance ledger) |

## Step 4 — revert

Both drill files restored from pre-drill copies; `grep opencode` over
`agent-runtime-id.ts` matches only the two comment mentions in the
`TRANSCRIPT_READ_STRATEGY_KINDS` ruling record; contracts rebuilt;
`turbo typecheck --filter=@cap-console/api --filter=@cap-console/web
--filter=@cap-console/runtime-conformance` → **12/12 tasks successful**.
