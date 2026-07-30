# Research brief

Measured on `81a115d` (the commit that archived
`converge-contracts-to-genuinely-shared`). Every figure below was produced by a
command run against that tree, not inherited from an assessment. Where a number
is an upper bound, it says so.

Two inputs: a six-candidate planning fan-out with three sequencing lenses and four
adversarial refuters, and a measurement pass of my own. The fan-out's leading pick
(the test-runner count) was **refuted** and is not this change; §6 records what
survived from it.

## 1. The defect class this change is about

The change that just shipped found the same defect twice and fixed both instances
it touched:

```
SmtpConfigReadSchema             zero call sites → the api emitted a blank tuple
                                 its own declared contract rejected
RuntimeReadinessResponseSchema   zero call sites → the api sent an envelope while
                                 the contract declared a bare array, from the very
                                 commit that introduced both (f050ab0)
```

Neither was noticed by any gate, because a schema nothing executes cannot notice
anything. The shipped gate (`scripts/contracts-shared-export-check.mjs`) measures
**import**-reachability, which is a different property. The capability spec
already states the missing one, and states it as a SHALL:

```
openspec/specs/monorepo-foundation/spec.md:382
  #### Scenario: A schema nobody executes is treated as unverified
  - WHEN a contract schema has no call site anywhere
  - THEN it SHALL be reported
```

That scenario was written into the spec during the previous change's archive and
nothing implements it. It is itself a rule that never runs.

## 2. How many schemas never run — measured, with its error bars

Probe: build a declaration graph over all 499 `export const|function` in
`packages/contracts/src`; seed with schemas on which non-test production code
under `apps/*/src` and `packages/*/src` calls `.parse` / `.safeParse` /
`.parseAsync` / `.safeParseAsync`, or which are handed to `ZodValidationPipe` /
`UsePipes` / `zodToJsonSchema`; propagate through declaration bodies (a schema
composed into an executed schema runs).

```
契约 *Schema 声明        371
  生产代码直接执行        134
  经组合被执行            218
  生产代码从不执行         68     ← UPPER BOUND, see below
```

**68 is an upper bound and at least 8 of it are false positives.** The `/v1`
surface parses through a runtime lookup — `public-v1-operation.ts:436-455` calls
`operation.input.params.parse`, `.query.parse`, `.headers.parse`, `.body.parse`
on an entry fetched from the operations table — so a schema reached only that way
is executed and a text-level probe cannot see it. Confirmed false positives:

```
PublicV1EventHeadersSchema  PublicV1IdParamsSchema  PublicV1IdempotencyHeadersSchema
V1CreateTaskRequestSchema   V1ListQuerySchema       PublicV1DeletionAcknowledgementSchema
V1ListSchedulesResponseSchema  V1ListScheduleRunsResponseSchema
```

So the real figure is **≈60, and the instrument that produces it does not exist
yet.** Track 1 builds it; the proposal must not quote 68 as a finding.

Never-run, by module, top of the list:

```
auth-account                              12
public-v1-operations                      10   ← mostly the indirection above
task-provisioning-diagnostics              6
mcp-token                                  5
notifications                              4   ← already an accepted exception
schedule                                   4
task-provisioning-diagnostics-capability   4
```

## 3. What is being violated RIGHT NOW

This is the question that separates urgency from tidiness. Three confirmed.

### 3.1 `AdminRevealResponseSchema` — the third instance of the shipped defect

```
contract  auth-account.ts   z.object({ email: EmailSchema, password: z.string().min(1) })
api       admin-reveal.controller.ts:54  return {};
                                     :80  return {};
                                     :82  return { email, password }
```

Two of the three return paths emit `{}` against a contract declaring both fields
required. Identical in kind to `EMPTY_SMTP_CONFIG_READ`, and unnoticed for the
identical reason: `AdminRevealResponseSchema` has no call site. This is the
operator's only channel for the seeded admin credential, and `scripts/boot-smoke.sh:125`
probes it before auth.

### 3.2 `accounts` local DTOs drop a bound the contract added deliberately

`apps/api/src/accounts/accounts.service.ts:197` opens a block literally headed
`// Local DTOs (validated at the controller via ZodValidationPipe)` and declares
five schemas the contract already declares:

```
local   CreateAccountSchema   password: z.string().min(MIN_PASSWORD_LENGTH)   // 8, NO upper bound
        ResetPasswordSchema   password: z.string().min(MIN_PASSWORD_LENGTH)
        AccountRoleSchema  SetEnabledSchema  AssignRoleSchema
contract PasswordSchema       z.string().min(8).max(200)
```

The contract's `.max(200)` carries a stated reason — the bound exists "so a single
field cannot be used to exhaust the argon2 hasher". The local restatement drops
it. `AdminCreateAccountRequestSchema` and `AdminResetPasswordRequestSchema` have
**zero references** anywhere in `apps/api/src` or `apps/web/src`.

**This is a drift between a declared rule and the enforced one, NOT a live
vulnerability.** Every account route is admin-gated. Overclaiming here is the
failure mode this programme keeps catching, and the proposal says so explicitly.

`apps/api/src/auth-otp/otp.controller.ts:24,28` is the same pattern with its own
TODO already in the file: local `OtpVerifySchema` uses `code: z.string().min(1)`
where the contract declares `OtpCodeSchema = /^\d{6}$/`.

### 3.3 `mcp-token` — `RuntimeReadiness` again, mirrored

```
api       mcp-tokens.controller.ts:71   return { tokens }
contract  mcp-token.ts:115              z.object({ tokens: z.array(...) })   ← agree
web       real.ts:1467                  export type ListMcpTokensResponse = readonly McpTokenSummary[]
          real.ts:1499                  Array.isArray(body) ? body : body?.tokens ?? []
```

Byte-for-byte the pattern Track 3 of the shipped change deleted at `real.ts:776`,
with the sides swapped: there the api disagreed with the contract, here the
console does. `McpTokenListResponseSchema` has no call site, so nothing notices.

## 4. Two defects in the gate that shipped 30 minutes earlier

Both were surfaced by the planning fan-out and then **verified by probe**, because
the fan-out's own supporting examples were wrong.

### 4.1 The schema/type pair rule is bypassed by self-reference

`isComposedInto()` scans every contracts source line for a reference to the name,
skipping only the export's OWN declaration line. But `export type X = z.infer<typeof XSchema>`
is a *different* line, so it counts as composition — which marks **every schema
that has an inferred type** as composed, before the pair rule is ever consulted.

Probe on the clean tree: adding a `GateProbeDeadPairSchema` + `GateProbeDeadPair`
pair that nothing anywhere uses → `every export is reachable`, **exit 0**. The
gate passes a fully dead pair.

Task 4.4's probe missed it because the throwaway export it used had no twin,
which is the one shape the (correctly fixed) pair rule does handle.

*Correction to the fan-out, and then a correction to the correction.* It cited
`AdminCreateAccountRequestSchema`, `AdminResetPasswordRequestSchema`,
`OtpVerifyRequestSchema` and `AdminRevealResponseSchema` as instances. I first
wrote that none of them was, on a reference count that had `packages/contracts/src`
inside its own search path — so every export appeared to have at least its own
declaration as a "consumer reference". Re-counted with the declaring package
excluded:

```
AdminCreateAccountRequest   7 consumer references   → genuinely live
AdminRevealResponse         2                       → genuinely live
AdminResetPasswordRequest   0                       → IN the hole
OtpVerifyRequest            0                       → IN the hole
```

So two of the four were in the hole and two were not, and the fix confirms it: with
the pair rule repaired, `AdminResetPasswordRequest*` and `OtpVerifyRequest*` appear
in the gate's dead list and the other two do not. **The number to trust is the one
the fixed gate prints, not either of my counts.** Both are recorded because the
shape of the mistake is the point — a search path that includes the thing being
searched for produces a confident number that means nothing.

### 4.2 The gate never scans `scripts/`

`consumerRoots()` walks only `apps/*` and `packages/*` whose manifest declares a
dependency on the contracts package. **16 files under `scripts/` reference
contracts**, several importing deep `dist/` paths the import regex would not match
either.

One consequence is already in the shipped tree: the gate's EXCEPTIONS entry keeps
`startsWithReservedPrefix` on the stated ground that "a test reimplements it
inline", while `scripts/legacy-token-prefix-collision.test.mjs:18` imports it
properly from `packages/contracts/dist/credential-prefix.js`. **The exception's
reason is falsified by a file the gate cannot see.**

This is why Track 0 comes first: every scope decision downstream is read off an
instrument that is currently wrong in two directions.

## 5. Decisions the user settled before this proposal

- **D2 — direction for the request-validation gaps: the api tightens onto the
  contract.** Over-long passwords and non-six-digit OTP codes begin returning 400.
  Chosen over relaxing the contract (which would retire the argon2 bound the
  comment declares) and over converging shape-only with recorded widenings.
- **D5 — carry the two-line `--test-force-exit` deletion.** This change will claim
  "counts unchanged, no coverage lost", and that sentence is currently footnoted
  by the previous change's own task 2.6.

Decided without asking, each with a recorded reason in `design.md`: the mcp-token
direction (web converges — api and contract already agree and web already
tolerates both, so nothing moves on the wire), the `AdminRevealResponse` ordering
(model the absent arm BEFORE adding the parse, never the reverse), and deleting
`AUTH_TOKEN_PUBLIC_ENV_VAR`.

## 6. What the refuted candidate leaves behind

The test-runner candidate was refuted on measurement, not taste:

- Truncation corrupts the count and the failure *diagnostic*, never the verdict —
  11/11 fixture runs with a planted failure kept `rc=1` / `# fail 1`. So no defect
  ships green, and ranking it first would have ranked the measuring stick above
  the thing measured.
- Its proposed audit channel is 5-9× lossier than the aggregate it audits under
  the same flag, so it would false-fire under exactly the condition it is sold
  against.
- `spawnSync({timeout})` orphans per-file children (measured), so the wall-clock
  kill needs a process-group model rather than a bolt-on.

What survived, and is carried here as a two-line hygiene fix: the flag itself.
Measured on one unchanged tree — **1599, 1599, 1596, 1597** with
`--test-force-exit`; **1599, 1599, 1599** without. Cost: 20-41s unforced vs
16-17s forced, which contradicts the "identical wall clock" the assessment
claimed.

Do **not** quote a truncation *rate*: 0/19, 2/15, 1/6 and 2/5 were all reported on
the same tree and the runner rate is unmeasured.

## 7. Explicitly out of scope

| Not here | Where it belongs |
|---|---|
| Per-file completeness reporter, out-of-process side channel, wall-clock kill | the test-runner change, if still wanted after §6 |
| Routing `test:public-surface` through `run-suite.mjs` | same — it feeds the REQUIRED branch-protection context `public-surface-parity`, so touching it needs its own change |
| Converging the inline-literal restatements (`'Bearer'` at ~30 sites, the `AUTH_TOKEN*` env names) | recorded as gate exceptions; a later change, and cheaper before the repo split than after |
| Epic Phase 1b (moving api-only modules) | the fan-out agent for it **failed** (structured-output retry cap), so its residual size is unverified; fold into whichever change next re-measures reachability |
| Epic Phase 1c (publishing) | needs a license, an `NPM_TOKEN`, and the epic-D5 answer. Note for whoever does it: §4 1c claims `peerDependency` fixes the zod problem and cites "three zod copies", but all four workspace packages symlink one physical zod and the live problem is an ESM/CJS **class-realm** split that a peer dependency cannot touch |
