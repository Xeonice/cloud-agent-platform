## Context

Measured on `1d9b0c0`. Full audit in the epic's §2.4b; the figures this change
acts on:

```
契约共享度（传递可达）    36 模块 / 10,104 行共享 · 3 / 648 仅 api · 4 / 138 无人可达
重声明审计（24 候选）     DUPLICATE 13 · DERIVED 5 · DIVERGENT 4 · COLLISION 1
```

Two duplicates have already drifted, and both are invisible for the same reason —
the schema that would catch them is never executed:

```
SmtpConfigReadSchema        全仓零调用点，而 api 发的 EMPTY_SMTP_CONFIG_READ
                            违反它自己的 .min(1)
RuntimeReadinessResponse    契约 z.array(…) vs api { runtimes: [...] }
```

The fix difficulty splits by package, not by symbol:

| | | |
|---|---|---|
| 10 | 所在包已依赖 contracts | `ModelDiscoveryErrorCode` `RepoCopyStatus` `SmtpConfigRead` `RuntimeReadiness` `SandboxMode` `ExecutionMode` `ApiKeyListItem` `SaveSmtpConfigRequest` `TestSmtpConfigRequest` `TestSmtpConfigResponse` |
| 3 | 在 `packages/sandbox-environment`，它只依赖 `sandbox-core` | `SandboxEnvironmentStatus` `SandboxEnvironmentParameter` `SandboxEnvironmentValidationProbe` |

The audit's own synthesis reported this split as 8/5 and placed `SandboxMode`
among the blocked. That was wrong: `SandboxMode`'s local copy is in
`apps/api/src/sandbox/sandbox-provider.port.ts`, and `apps/api` has depended on
contracts all along. Re-derived from each package's manifest, it is 10/3.

Constraints:

- `packages/sandbox-core` declares **zero** runtime dependencies.
- `packages/sandbox-environment/test/package-boundary.test.mjs:28` asserts
  `Object.keys(dependencies)` is exactly `['@cap-console/sandbox-core']`. It
  inspects `dependencies` only, and its forbidden-import pattern does not name
  `@cap-console/contracts`.
- All three blocked symbols appear in `packages/sandbox-environment/src/index.ts`
  in type position only (`readonly status: X`, `readonly X[]`). None needs a value.

## Goals / Non-Goals

**Goals:**

- Every shared type has one declaration.
- Dead contract exports fail the build rather than accumulating.
- Zero behaviour change, except where a declaration and the wire already
  contradict each other — there, one of the two conforms and which one is a
  decision with evidence behind it, not a default. This was first written as
  "there, the wire conforms"; D6 found a pair where the wire was right and the
  declaration was the thing that had never been true.

**Non-Goals:**

- Publishing, versioning, or any repository restructuring.
- Converging the 4 DIVERGENT cases.
- Changing how the console validates responses.

## Decisions

### D1 — Type-only imports, so the dependency graph does not move

The three blocked symbols converge with `import type`, which TypeScript erases,
so `packages/sandbox-environment` gains a `devDependency` and no runtime edge.
Its boundary test inspects `dependencies` and keeps passing — not by accident but
because that is the distinction the test was written to draw.

*Alternative rejected — add `@cap-console/contracts` to `dependencies`.* It would
break the boundary test correctly: contracts depends on zod, so the runtime graph
of a package whose whole point is minimal dependencies would grow one.

*Alternative rejected — leave the three and accept 10 of 13.* The three are the
ones a split would carry into a separate repository, where converging them costs
a publish cycle instead of an import.

### D2 — `sandbox-core` converges by type and is reconciled by gate at runtime

Per epic D14. `sandbox-core/provider.ts` takes the family and source-kind types
from the contract via `import type`; `sandbox-core/provisioning-diagnostics.ts`
keeps its own value-level array, because `validateEnum` consumes it at runtime and
a value import would pull zod into a package that must have no runtime
dependencies at all.

A parity gate asserts the two sides agree. Written here as "the diagnostics list
plus its one explicit widening (`'unknown'`)", which the implementation
contradicts twice and the correction is worth keeping visible.

**Ten arrays, not one.** `SANDBOX_EXECUTION_MODES`, `WORKSPACE_SOURCE_KINDS`, and
eight `SANDBOX_PROVISIONING_DIAGNOSTIC_*` lists all mirror a contract enum.
`SANDBOX_WORKSPACE_MATERIALIZATION_STAGES` and
`SANDBOX_PHYSICAL_CLEANUP_OUTCOMES` do not — no api response names those steps —
so they are recorded as sandbox-core-only rather than silently skipped.

**No widening.** The `'unknown'` in `z.enum([...SANDBOX_PROVIDER_FAMILIES,
'unknown'])` is the contract widening `SANDBOX_PROVIDER_FAMILIES`, not the
contract widening sandbox-core: sandbox-core's own diagnostics list already
contains `'unknown'` literally, so the two sides are equal, not offset. The gate
keeps the mechanism (`extraInSandbox` / `extraInContract`, both empty today) so a
future divergence has to be written down instead of absorbed.

The gate compares member **sets**. Order already differs — `aio, cloud-http,
boxlite, unknown` in sandbox-core against `aio, boxlite, cloud-http, unknown` in
the contract — and every consumer reaches these arrays through `validateEnum`,
which does `includes`. Asserting order would fail on a difference that means
nothing, which is how a gate gets disabled.

*Alternative rejected — move the vocabulary down into `sandbox-core` and have
contracts derive.* Clean in isolation, but contracts is about to be published and
would then carry `@cap-console/sandbox-core` as a dependency, which is not
published. It trades one problem for a harder one.

### D3 — Converge before deleting, measure in between

`runtime.ts` and `sandbox.ts` are dead **because** consumers re-declared them.
Deleting them first would ratify the duplication, and the same shape would regrow
under a third name — `AdminRevealCredentials` and `McpTokenScope` are that
happening already.

So: converge, re-run the reachability measurement, and let the new result decide
what is dead. The post-convergence dead list is unlikely to be today's four.

### D4 — The two drifted pairs are behaviour changes and are treated as such

Converging `SmtpConfigRead` makes `EMPTY_SMTP_CONFIG_READ` fail its own contract
(`host: ''` against `.min(1)`). Converging `RuntimeReadiness` confronts an
envelope mismatch the console already works around.

Neither is a rename. Each needs a decision — does the contract describe what is
sent, or does what is sent become what the contract describes? — and evidence that
the answer did not break a consumer. They are separated from the other eleven in
the tasks for that reason.

### D5 — The gate states the property, not the instances

A gate listing today's dead exports would need editing every time. The gate
asserts the property: **an export in `packages/contracts` that no consumer imports
fails the build.** Anything legitimately unimported states itself as an exception
with a reason, in the shape `test-discovery-check.mjs` already uses.

This is the check every existing gate missed. `turbo typecheck lint`, the contracts
suite, the package-boundary tests and `provider-contract-parity-check.mjs` are all
green today with six dead exports and thirteen duplicates in the tree.

### D6 — `SmtpConfigRead`: the contract is wrong, and the read/write asymmetry is why

The Goals section says "where a declaration and the wire already contradict each
other, the wire conforms". For this pair it is the other way round, and the
evidence is what changed the answer.

`SmtpConfigReadSchema` declares `host`/`user`/`from` as `.min(1)` and `port` as
`.min(1)` — that is, "a read always describes a configured server". Three
reachable states say otherwise:

```
smtp.controller.ts:74   null ⇒ EMPTY_SMTP_CONFIG_READ   host:'' port:0 user:'' from:''
saveConfig without pass  hasPassword:false with a full non-empty tuple
                         — so hasPassword is NOT a discriminant for "configured"
web mock initial state   host/port/user = the fixed Resend tuple, from:''
```

The third is what rules out the tidier fix. A two-branch union
(`z.literal('')` for unset against `.min(1)` for set) states the intent exactly
and would reject the mock, which is a real shape the console renders. There is no
field that discriminates the two states, and adding one would change the wire.

So the read shape relaxes: `host`/`user`/`from` become `z.string()`, `port`
becomes `.min(0)`. **`SaveSmtpConfigRequestSchema` keeps every `.min(1)`.** That
asymmetry is the actual finding — a read projection of a possibly-unset singleton
and a write body that creates it are different shapes, and the read was written as
if it were the write. The strictness belongs on the way in, where it can reject
something; on the way out it only made the declaration false.

The console needs no change: it already renders the unset state
(`configured = config?.hasPassword === true`, `fromLabel = config?.from || "未设置"`).

*Alternative rejected — make the api conform by returning 404 for an unset
config.* It moves a real state into an error channel, and the console's query
would have to read a 404 as data.

### D7 — `RuntimeReadiness`: the api conforms, because nothing ever depended on the envelope

The opposite call to D6, on the same criterion: what does the evidence say was
true. Here `git log -S` settles it — the contract's `z.array(…)`, the api's
`{ runtimes: [...] }`, and the console's code tolerating both all landed in
**one commit**, `f050ab0`:

```
f050ab0  contracts/runtime.ts       RuntimeReadinessResponseSchema = z.array(…)
f050ab0  api/runtimes.service.ts    return { runtimes: [ … ] }
f050ab0  web/real.ts                "tolerate a bare array too" — both branches
```

The declaration was never true, not for one commit. And because the tolerance
shipped in the same change that introduced the endpoint, **no console build has
ever existed that could not read a bare array** — which removes the reason to
prefer the wire: there is no deployed consumer to break, and `/runtimes` is
console-only (absent from `/v1` and from the MCP tool surface).

So the api conforms. A plain list is a bare array in this contract by a 2:1
majority — `ListRepos`, `ListTasks`, `ListSchedules`, `ListScheduleRuns`,
`ListAuditEvents`, `ListAvailableGithubRepos`, `ListPendingApprovals`,
`ListForgeCredentials`, `ListAvailableForgeRepos` — and the envelopes
(`ApiKeyList`, `McpTokenList`, `AdminAccountList`, the sandbox-environment lists)
carry more than a list. This one carries only a list.

Converging it also removes the api's local `RuntimeReadiness` / 
`RuntimesReadinessResponse` pair, which is the half of that DUPLICATE task 2.1
deliberately deferred here.

*Alternative rejected — declare the envelope in the contract.* It is the smaller
diff and touches no wire, but it ratifies a shape whose only justification is
that it was typed first, and it keeps a list response inconsistent with nine
others for no stated reason.

## Risks / Trade-offs

- **[Converging a type changes inference somewhere subtle]** → The audit found
  three sites where a cast erases the vocabulary entirely
  (`sandbox-environments.service.ts:410/550` `as never`, `task-response.ts:288`).
  A converged type behind a cast changes nothing and hides nothing changing, so
  those sites are checked explicitly rather than trusted to the compiler.

- **[The gate flags exports that are legitimately unimported]** → Expected. The
  exception list exists for that, and an exception with a reason is the outcome —
  what the gate prevents is the silent kind.

- **[Re-measuring after convergence returns a list nobody expects]** → That is the
  intended result of D3, not a risk. The current four-module dead list was
  computed while the duplication was in place.

- **[Scope creep into the DIVERGENT cases]** → Explicitly a Non-Goal. They are
  disagreements between two sides about what is compatible, and they belong to the
  phase that defines compatibility.

## Migration Plan

None. No environment, database, image, or wire-format change. The two drifted
pairs alter what a declaration says about bytes that were already being sent;
neither adds or removes a field. Rollback is a revert.

## Open Questions

None blocking. The publishing questions — `zod` as a peerDependency, release-please
multi-package, and what a contracts version means against the umbrella tag (epic
D5) — belong to the change that publishes, and this one does not depend on them.
