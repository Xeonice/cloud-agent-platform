# Verification report — converge-contracts-rules-that-never-run

**Verdict: NOT ARCHIVABLE.** Three requirements, zero reclassified as MET, three
re-opened as code tasks, four blocking spec defects.

The unusual shape of this result deserves stating up front, because it is easy to
misread: **the static trace of all three requirements came back clean.** The
scripts exist, are wired into `package.json` and CI, both gates were run by hand
and pass green, and every code-level convergence the tasks claim
(`accounts.service.ts`, `otp.controller.ts`, `admin-reveal.controller.ts`, the web
mcp-token envelope, the `AUTH_TOKEN_PUBLIC_ENV_VAR` deletion, the CI
`timeout-minutes`) is present exactly as described. No requirement here is a paper
trail over an empty implementation — which is the failure mode this programme
usually catches, and it is not what happened.

What stops the change is two things static tracing cannot fix: the mandatory
dynamic evidence lanes did not run, and the `surface-impact.json` sidecar declares
four surfaces unchanged that the diff contradicts.

## What was traced, and what it showed

All three findings below are recorded as **advisory**. Each requirement carries
public-surface dynamic verification in its task metadata, which means a static
read — however thorough — is corroboration, not closure. They are folded in here
so the work is not repeated, not so it can be counted.

### `an-export-nothing-can-reach-shall-fail-the-build` — static trace clean

`scripts/contracts-shared-export-check.mjs` computes `dead` as exports neither
imported (including via `scripts/` consumers, the Track 0 fix), nor composed into
another export, nor covered by a live schema/type twin, minus a hand-written
`EXCEPTIONS` list where every entry carries a reason. Pair-self-vouching is
excluded explicitly — `isComposedInto` skips both the export's own declaration
block and its twin's — which is the Track 0 defect, and it has a red-then-green
test pinning it (`a schema/type pair vouching only for itself is reported dead`).
`main()` sets `process.exitCode = 1` and names each dead export.

Wired to fail: `package.json:20` `test:contracts-shared`, run at
`.github/workflows/ci.yml:300-301` inside the required `typecheck-lint` job, no
`continue-on-error` anywhere in the file.

Reproduced live: script exit 0 on the clean tree (853 exports across 42 modules);
appending a throwaway `export const __Z_PROBE_DEAD_EXPORT__` to a contracts module
turned it to exit 1 naming exactly that export; reverting returned it to green.
12/12 self-tests pass.

One clause is upheld by review discipline rather than by code: "convergence
precedes deletion" lives in the `EXCEPTIONS` comments (the `IdentityProvider` /
`TaskFailureAction` D3 entries), and no automated check can detect that a
restatement was converged before an export was removed. That is a known limit, not
a defect.

### `a-shared-type-shall-have-exactly-one-declaration` — static trace clean

All four tagged tasks (2.3, 2.4, 2.6, 2.7) trace end to end:

- `accounts.service.ts:8` imports `AdminCreateAccountRequest` / `Role` from
  `@cap-console/contracts`; five local DTOs are gone and the call sites in
  `accounts.controller.ts` name the contract schemas directly. `PasswordSchema`'s
  `.max(200)` bound is restored at `packages/contracts/src/auth-account.ts:50`.
- `otp.controller.ts:12-18` imports `OtpRequestRequestSchema` /
  `OtpVerifyRequestSchema`; grep finds zero surviving production references to the
  two deleted local schemas.
- Both files document, in comments, that a first attempt via a local *alias* was
  rejected — matching `spec.md:86-93` "a convenience alias is not a convergence".
  That is the newly-added scenario, and these call sites are the defect it names.
- `apps/api/test/tightened-request-surfaces.test.mjs` runs 9/9, including the
  cross-field password rule and the six-digit OTP rule.
- `apps/web/src/lib/api/real.ts:1448-1456` deletes the local `McpTokenSummary`,
  re-exports the contract's `McpTokenListItem`, and `listMcpTokens()` reads only
  `body.tokens` with the bare-array tolerance removed.

Two dependent tests were corrected rather than accommodated
(`mcp-server-section.test.ts` stubbed a bare array the api has never sent;
`auth.guard.spec.ts` used `'tok-1'` where Prisma generates a uuid) — both were
asserting the drift, and both edits are the right direction.

Risk stays high regardless of the clean trace: this touches admin account
creation, password reset, OTP login and MCP-token mint, all credential-handling
and all Prisma-writing.

### `a-rule-...-shall-be-executed-against-the-wire-it-describes` — static trace clean, two real defects found

The scan seeds `executed` from direct parses, propagates through composition
across *every* declaration (not only `*Schema`-suffixed ones — the Track 3 fix),
computes `testOnly` separately and never merges it into `executed`, and reports
everything else. Indirection is declared, not inferred: `INDIRECTION_POINTS` names
module, wrapper regex, parse site and reason per entry, and only entries whose
declared wrapper actually matches are marked executed.

Wired at `package.json:21` and `ci.yml:311-312`, same required job.

Reproduced live: 390 schemas, 374 executed, exit 0; injecting an
exported-and-typed-but-never-parsed schema produced `1 schema(s) nothing runs` and
exit 1. 7/7 self-tests pass.

D7's "proved against this defect's shape" claim is honest but is a *process* trace
— `GateProbeUnparsedSchema` was a development-time probe recorded in tasks.md, not
a standing fixture in the test file. The distinction matters if someone later
refactors the pair rule and expects a test to catch it.

Two defects surfaced during the trace and are now tasks 5.2 and 5.3: `parsesSchema()`
counts `zodToJsonSchema(X)` and `parseZodValue(X)` as execution, and **both forms
have zero call sites in the repository**. Reflection into JSON Schema validates no
wire bytes at all, which is the reachable-but-unexecuted case the spec exists to
separate from execution; and the literal-name `parseZodValue` pattern is blanket
textual inference over exactly the path D2 chose declared indirection to avoid
(the real call sites pass `operation.input.params.parse`, a property path). Task
1.1 enumerates six recognised forms; the implementation ships eight. Neither extra
is dangerous today — nothing matches them — which is precisely why they would sit
there until the first OpenAPI-only reference walks through.

Task 5.4 records a third, smaller finding: two empty untracked probe files
(`packages/contracts/src/health.ts`, `packages/contracts/src/task.js.refute-test`)
were left in the production contracts source directory, and the executed-schema
scan's `readdirSync` reads the first as a real contracts module.

## Why nothing is counted MET

### The dynamic lanes did not run

`surface-impact.json` sets `verification.id: "contracts-registry"` with
`requiresWireCompatibilityFixture: true`. Four mandatory dynamic evidence lanes —
`registry`, `restMetadata`, `mcpSdkMetadata`, `behavior` — produced no passing
run. The change nominated dynamic verification for these requirements itself; a
static read cannot then stand in for it, however clean. Re-opened as task 5.1 for
all three requirements.

### The sidecar declares four surfaces unchanged that the diff contradicts

`publicV1`, `mcp`, `openapi` and `apiPlayground` are all declared `unchanged`
while the code evidence shows movement on each. The clearest instance is `mcp`:
`mcp-tokens.controller.ts` now parses mint, list and revoke responses on the way
out, so a drifted row 500s where it previously served, and the console drops its
tolerance for the other shape in the same change. The declared reason —
"GET /mcp-tokens is the console's token-management endpoint, not an MCP tool" — is
a true sentence that does not address what changed.

These are routed as **spec defects, not code defects**. The code is plausibly
correct; what is undecided is what the sidecar should claim, and that is a
judgement the verifier must not make on the author's behalf. They are written up
as design.md Open Questions Q1-Q4, with task 5.5 tracking the correction, and they
block archive because archive cannot accept a sidecar claim the diff falsifies.

## Tally

| Route | Count | Requirements |
| --- | --- | --- |
| Re-opened as code tasks | 3 | all three (dynamic evidence, tasks 5.1-5.4) |
| Blocking spec defects | 3 | all three (undeclared surface impact, Q1-Q4, task 5.5) |
| Reclassified MET | 0 | — |

Every requirement appears on both re-opened and blocking rows: the dynamic-evidence
gap is a code/verification task, the sidecar declarations are an authoring
decision, and the same three requirements carry both.
