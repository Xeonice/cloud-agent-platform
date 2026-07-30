## Context

Measured on `81a115d`. Full evidence in `research-brief.md`; the figures this
change acts on:

```
契约 *Schema 声明        371
  生产代码直接执行        134
  经组合被执行            218
  生产代码从不执行         ≈60   （文本探针报 68，其中至少 8 个是 /v1 表驱动间接执行的误报）
```

Three of those are being violated today, and one is the third instance of the
defect the previous change fixed twice:

```
AdminRevealResponseSchema  契约 { email, password } 必填 vs controller:54,80 返回 {}
accounts 本地 DTO          accounts.service.ts:197 重述五个契约 schema，丢掉 .max(200)
mcp-token 列表信封         api {tokens} = 契约，而 web 声明裸数组 + 双分支容错
```

Constraints:

- **The instrument is currently wrong in two directions.** The shipped gate's
  pair rule is bypassed by `export type X = z.infer<typeof XSchema>` counting as
  composition (probe: a fully dead pair passes, exit 0), and `consumerRoots()`
  never walks `scripts/`, where sixteen files reference contracts — which already
  falsifies the gate's own exception reason for `startsWithReservedPrefix`.
- **`/v1` parses through a runtime lookup.** `public-v1-operation.ts:436-455`
  calls `operation.input.params.parse` / `.query.parse` / `.headers.parse` /
  `.body.parse` on a table entry, so eight schemas that no text probe can see are
  in fact executed. Any execution scan that does not model this reports them dead.
- **`scripts/boot-smoke.sh:125` probes `/auth/admin-reveal` before auth**, so that
  endpoint's shape is load-bearing for CI, not only for an operator.
- **User decisions already taken**: the api tightens onto the contract for the
  request-validation gaps (D2), and the `--test-force-exit` deletion is carried
  (D5).

## Goals / Non-Goals

**Goals:**

- Every rule `packages/contracts` states is executed against the wire it
  describes, or is a written-down exception.
- The gate that asserts this can be shown to fail on the shape it exists to
  catch — not merely on some shape.
- The two instruments this change depends on are correct before anything is
  scoped from them.

**Non-Goals:**

- Converging the inline-literal restatements.
- Any test-runner work beyond deleting the flag.
- Publishing, module moves, repository restructuring.

## Decisions

### D1 — Fix the instrument first, and re-derive every downstream number from it

Track 0 exists because two of this change's own scope decisions would otherwise be
read off a broken measurement. The order is not stylistic: the shipped gate's
exception list contains at least one reason that is **false**, and it is false
about a file the gate structurally cannot see.

The pair fix: composition must not count a reference that is the pair line itself.
An export is composed only when some export **other than its own twin** is built
from it.

The scan fix: `scripts/` joins the consumer set. It is not a workspace package, so
it is added as an explicit repository-scoped directory, the shape
`test-discovery-check.mjs` already uses for the same problem (`REPOSITORY_TEST_DIRS`).

*Alternative rejected — fix the gate in a follow-up and scope this change from the
current numbers.* It would mean writing a proposal whose evidence is known-wrong
at the moment of writing.

### D2 — Execution-reachability models declared indirection, it does not guess

A schema RUNS when production code parses it, or when it is composed into a schema
that runs. `/v1` breaks that with a table: the parse call names a property path,
never the schema. Three ways to handle it:

1. Text-match `.parse` on property paths — catches nothing, since the path names
   `operation.input.query`, not the schema.
2. Treat every export the table references as executed — correct for `/v1` and a
   blanket amnesty for anything else that gets put in a table.
3. **Declare the indirection points.** The gate carries a short list of
   "parse happens here, over these entries", each with a file:line. `/v1`'s
   operation table is the only one today.

Option 3, because it makes the exemption a statement someone must write and review
rather than a property of being reachable from a big object. A new indirection
point costs one entry; forgetting one costs a false positive that shows up
immediately, which is the failure direction to prefer.

*Note on the number:* the text probe reports 68 never-run and at least 8 are
`/v1` false positives. **The proposal deliberately does not quote 68 as a
finding**, and Track 1 re-measures with the real instrument before Track 2 scopes
anything.

### D3 — `mcp-token`: the console converges, because the api and contract agree

This is `RuntimeReadiness` with the sides swapped, and the swap changes the
answer. There, three declarations landed in one commit and the *contract* was the
odd one out; here the api (`mcp-tokens.controller.ts:71` returns `{ tokens }`) and
the contract (`mcp-token.ts:115` declares the envelope) already agree, and only
`apps/web` declares a bare array.

So the console converges and its both-branch tolerance at `real.ts:1499` goes.
Nothing moves on the wire, which means no deployed console can break: it already
reads the envelope branch today.

*Alternative rejected — change the contract to a bare array to match the console.*
It would move the wire to satisfy the one side that is wrong, and re-open a
question two of three parties had already settled.

### D4 — The request-validation gaps tighten, and the proposal says what they are not

Per the user's decision. `accounts.service.ts` and `otp.controller.ts` lose their
local DTOs and use the contract's, which restores `.max(200)` on passwords and
`/^\d{6}$/` on OTP codes.

**These are drifts between a declared rule and the enforced one, not live
vulnerabilities.** Every account route is admin-gated; the OTP code is generated
by the api itself, so a real code always matches. Stating it any stronger would be
the exact over-claim this programme keeps catching in itself, and the evidence
does not support it.

The behaviour change is real and small: a password over 200 characters and a
non-six-digit OTP code start returning 400. Both are verified against the
pre-change tree — a case that passes on the old code is not evidence.

*Fallback if the tightening proves unsafe in verification:* converge the shape and
record each widening as an explicit extension, the pattern the spec already
requires for the sandbox vocabularies. This is written down so the retreat is a
decision rather than an improvisation.

### D5 — `AdminRevealResponse`: model the absent arm first, add the parse second

The controller returns `{}` on two of three paths against a contract declaring
both fields required. Adding the parse first would turn a working endpoint into a
500 on its majority path — and `scripts/boot-smoke.sh:125` probes it pre-auth, so
CI would go red for the right reason at the wrong time.

So: the contract models "no credential to reveal" as a real arm, then the parse
goes in. Never the reverse. The boot smoke probe is also what makes the change
verifiable rather than merely typechecked.

### D6 — `AUTH_TOKEN_PUBLIC_ENV_VAR` is deleted, not corrected

It declares `'NEXT_PUBLIC_AUTH_TOKEN'`, a name from the Next.js console that no
longer exists. The string appears in exactly three places repository-wide: its own
declaration, its own doc comment, and the exception reason written for it last
week. The console reads `VITE_AUTH_TOKEN` (`apps/web/src/lib/config.ts:238`).

Correcting it would keep a browser-only env-var name in a package defined as the
things both sides share, and the api never reads it. Deleting it is the smaller
future cost, which is the criterion this programme uses for cleanup.

### D7 — The gate is proved against THIS defect's shape, not a generic one

Task 4.4 of the previous change proved its gate with a throwaway export that had
no schema/type twin — the one shape the pair rule handles correctly — so a
whole class walked through. The lesson generalises: **a gate must be proved
against the shape it exists to catch.**

For this gate that means the probe is not "a schema nobody imports". It is a
schema that IS imported, IS composed into a live type, and is never parsed —
because that is what `SmtpConfigReadSchema` looked like on the day it was wrong.

## Risks / Trade-offs

- **[The execution scan reports something executed that is not]** → The `/v1`
  indirection is one known instance and is handled by declaration. Others may
  exist. Mitigation is direction: the scan fails toward reporting, and a false
  positive surfaces at once as a name someone must adjudicate, while a false
  negative is silent — the exact asymmetry that let three schemas drift.

- **[Tightening a live request surface breaks a real caller]** → Both surfaces are
  admin-gated or api-generated, and both are verified against the pre-change tree.
  D4 records the fallback so retreating is a decision, not a scramble.

- **[Track 0 changes the exceptions list and therefore this change's own scope]** →
  Expected, and the reason Track 0 is first. Any exception whose reason
  measurement falsifies is deleted rather than reworded.

- **[Deleting `--test-force-exit` makes a suite hang]** → The flag exists for a
  reason nobody recorded. Measured: three unforced runs completed at 20-41s
  against 16-17s forced. If a hang appears later, the finding is an open handle
  worth naming, which is more useful than the flag hiding it.

## Migration Plan

None. No environment, database, image, or wire-format change. The two tightened
request surfaces reject inputs that were previously accepted; nothing that a
working client sends today stops working. Rollback is a revert.

## Open Questions

The two questions this change deliberately does not answer — whether the
inline-literal restatements converge, and whether the test-runner gets a real
completeness instrument — are recorded in the proposal's Non-Goals with where each
belongs.

Four raised by verification, and now ANSWERED with evidence rather than argument.
The verifier was right that none was a code defect and right that the sidecar had
to be decided by a person; three of the four reasons were true and incomplete, and
one was true and silent about a real new failure mode.

### Q1 — `mcp: unchanged` — TRUE of the protocol, and the carve-out is now written

No file under `apps/api/src/mcp/` is touched; no tool, argument, result shape,
registration or transport moves. But `/mcp-tokens` gained three outbound parses,
so a stored row that drifts from its declaration now fails the request where it
previously served an unvalidated body. The wire shape does not move and a new
failure mode appears — both true, and the first draft said only the first. The
`mcp` reason now carries the carve-out by name and the behaviour is declared under
`internalOnly`, which was already `changed`.

### Q2 — `public-v1: unchanged` — TRUE on the wire, and the new coupling is stated

No file under `apps/api/src/v1/` or `public-v1-operations.ts` is modified. What the
first draft did not say: the execution gate's `INDIRECTION_POINTS` entry pins
`public-v1-operation.ts:436-455` by file, line range and wrapper pattern, so
refactoring that parse site now fails a repository gate. A new coupling to the
public surface with no byte on it moving. Now in the reason.

### Q3 — `openapi: unchanged` — TRUE, and verified rather than asserted

`grep AdminReveal|McpToken apps/api/src/openapi/openapi.registry.ts` returns ZERO
hits. Neither the new `AdminRevealResponseSchema` arm nor any added response parse
is projected into a published document. The reason now cites the check instead of
the registry in the abstract.

### Q4 — `playground: unchanged` — TRUE, and inherited, which is what it should say

The playground builds from `PUBLIC_V1_OPERATIONS` (`catalog.ts:5,83`), untouched;
no file under `apps/web/src/components/api/` is modified. The reason now says it is
inherited from `openapi` rather than independently load-bearing.

### What verification found in the gate itself

Three things, all real and all fixed rather than argued with:

- `parsesSchema()` counted `zodToJsonSchema(X)` as execution. Reflection produces a
  document, not a verdict on any bytes — it is precisely the reachable-but-unexecuted
  amnesty this gate exists to separate, and it would have exempted the first
  OpenAPI-only reference anyone added. Zero call sites; removed.
- It also counted `parseZodValue(X)` by literal name. The real call sites pass a
  property path, which is why D2 chose declared indirection over textual inference.
  Zero call sites; removed. Six recognised forms became four.
- Two empty probe files (`packages/contracts/src/health.ts`,
  `task.js.refute-test`) were left in the production contracts source directory by
  gate probes, where `readdirSync(CONTRACTS_SRC)` reads them as real modules.
  Deleted.
