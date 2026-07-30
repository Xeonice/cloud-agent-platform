# Pre-change baseline

Working tree at `9d13ae7` (untracked: this change; modified: the epic doc).
Track 4 compares against every number here.

## Suites (task 1.1)

```
turbo run build                       all cached, 0 failures
@cap-console/api  test:compiled       1599 run / 1595 pass / 4 skipped / 0 fail
@cap-console/api  test:src             293 run /  293 pass / 0 fail
@cap-console/api  test:suite            12 run /   11 pass / 1 skipped / 0 fail
@cap-console/contracts test            229 run /  229 pass / 0 fail
@cap-console/web  test                 613 pass across 82 files
```

## Contract reachability (task 1.1)

Transitive closure from each consumer's imported symbols, following intra-package
imports inside `packages/contracts/src`:

```
web / sandbox / hooks 可达   36 模块 / 10,104 行
仅 api 可达                   3 模块 /    648 行
谁都不可达                    4 模块 /    138 行
                              runtime · notifications · sandbox · terminal-recording-internal
```

**This dead list was computed while the duplication was still in place.** Task 4.1
re-measures; per design D3 the post-convergence list decides what is removed, not
this one.

## Shape diff, per duplicate (task 1.2)

Every one of the thirteen is used in **type position only**, so `import type`
suffices throughout and no runtime dependency edge moves.

| symbol | shapes identical | what differs |
|---|---|---|
| `RepoCopyStatus` `SandboxMode` `ExecutionMode` `ApiKeyListItem` `SaveSmtpConfigRequest` `TestSmtpConfigResponse` `SandboxEnvironmentStatus` | **yes** | — |
| `ModelDiscoveryErrorCode` | no | member ORDER only; the set is identical and order is unobservable for a union |
| `TestSmtpConfigRequest` | no | contract makes all five fields optional, the local requires four. Converging **widens** |
| `SmtpConfigRead` | no | `passLast4` optional in the contract, required in both locals. Converging **widens** |
| `SandboxEnvironmentParameter` `SandboxEnvironmentValidationProbe` | no | `readonly` modifiers only — `z.infer` produces mutable properties |
| `RuntimeReadiness` | no | **api side**: `readonly` only, safe. **web side**: see below |

### The one that is not mechanical

`RuntimeReadiness` on the console breaks at `apps/web/src/lib/api/real.ts:781`:

```
error TS2322: Type 'string' is not assignable to type '"claude-code" | "codex"'
```

`id` is narrowed only to `string` by the guard on line 780 — deliberately, and
lines 777-779 record that this narrowing was once a real bug. Fixing the break by
tightening the guard would make `getRuntimes` **drop a runtime id a newer api
reports**, which is exactly what the console's `id: string` exists to prevent.
So the api half converges in Track 2 and the console half is Track 3's, where
task 3.4 already forbids narrowing it.

### Two prerequisites the diff surfaced

- `packages/sandbox-environment` has no path to `@cap-console/contracts` at all
  (`TS2307`). It needs the dependency in **`devDependencies`** — verified that
  its `package-boundary.test.mjs:28` still passes there, since that assertion
  reads `dependencies` only.
- Three files re-export the symbol they declare (`settings/index.ts`,
  `real.ts`). A bare `export type { X } from '@cap-console/contracts'` re-exports
  without binding the name locally and fails at every local use site; the working
  form is `import type { X } …; export type { X };`.

### A deliberate deviation

Converging to `z.infer` types loses `readonly` on properties that carried it.
Rather than accept that, the local declaration becomes `Readonly<ContractX>` where
it had readonly — a derivation, not a restatement, so it cannot drift while
preserving what the author wrote.

### `SandboxMode` moves from 2.1 to 2.3 — it is D14's fourth case

The audit judged it DUPLICATE, upgrading a refuter's DERIVED. Read against the
source, that upgrade does not hold:

```
apps/api/.../sandbox-provider.port.ts:52   export type SandboxMode = SandboxExecutionMode;
packages/sandbox-core/src/provider.ts:56   'read-only' | 'workspace-write' | 'danger-full-access'
packages/contracts/src/sandbox.ts:12       z.enum([same three])                    ← dead
```

The api's declaration is a **derivation from `sandbox-core`**, not a restatement of
the contract. The refuter's evidence — mutating the contract's copy leaves the
whole repository green — is true and establishes that `contracts/sandbox.ts` is
dead. It does not establish that the api holds a copy of it.

This is the same vocabulary in two homes with the dependency-free package unable
to reach the contract: provider family, source kind, and now sandbox mode. Handled
under D14 in task 2.3, not converged mechanically. Converging it the 2.1 way would
repoint `sandbox-provider.port.ts` from sandbox-core to contracts — the opposite
of what D14 decided.

### A stale comment this change has to fix

`apps/api/src/agent-runtime/agent-runtime.port.ts:87` claims the port "never
imports the parsers or `@cap-console/contracts`". Line 1 of the same file:

```ts
import { DEFAULT_AGENT_RUNTIME_ID, type AgentRuntimeId } from '@cap-console/contracts';
```

That import arrived with `derive-runtime-vocabulary-from-registration` (`d3c0b1b`,
already on main) and the comment ten lines below it was not updated. `ExecutionMode`
lives in this file, so converging it needs the import regardless — the comment is
corrected here rather than left to contradict the file it describes.
