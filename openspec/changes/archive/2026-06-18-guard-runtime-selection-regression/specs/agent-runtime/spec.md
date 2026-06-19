## ADDED Requirements

### Requirement: Persisted task runtime deterministically selects the provisioning runtime, guarded against silent regression

A task's persisted `runtime` value SHALL deterministically select the runtime used to provision and launch it: a `claude-code` task SHALL be provisioned by the Claude runtime, and a `codex` or runtime-absent task by the codex runtime. The orchestrator SHALL NEVER silently provision a runtime different from the one the task selected.

The selection seam SHALL be guarded against silent regression at three layers, because this exact path shipped 100% broken in v0.6.0 (a `claude-code` task was silently provisioned through codex) and had to be fixed twice:

- **Compile-time.** The runtime registry SHALL depend on the `ProvisionLookup` port's `getTaskRuntime` as a REQUIRED member (no optional/widening cast, no `typeof`-presence escape hatch). An implementation of `ProvisionLookup` that omits `getTaskRuntime` SHALL be a build-time type failure, not a runtime fallback.
- **Test-time.** A fast (CI-lane, non-skipping) test SHALL exercise the REAL registry against a real-shaped `ProvisionLookup` — and the real `PrismaProvisionLookup` against a fake persistence client — asserting that the persisted runtime resolves the matching runtime. This coverage SHALL NOT rely solely on the self-hosted, token-gated, self-skipping compose e2e.
- **Run-time.** When the runtime cannot be resolved from persistence — the lookup is genuinely unwired, the lookup errors, or the stored value is outside the known set — the orchestrator MAY fall back to the codex default but SHALL log the fallback at `warn` level. A degradation to the default SHALL NOT be silent.

#### Scenario: A claude-code task resolves the Claude runtime through the real seam

- **WHEN** a task persisted with `runtime = "claude-code"` is resolved for provisioning through the real `IntegrationRuntimeRegistry` backed by a `ProvisionLookup` that returns the persisted value
- **THEN** the resolved runtime is the `ClaudeCodeRuntime` (id `claude-code`), never the codex runtime

#### Scenario: A codex or runtime-absent task resolves the codex runtime

- **WHEN** a task persisted with `runtime = "codex"` — or with no runtime value — is resolved for provisioning through the real registry + lookup
- **THEN** the resolved runtime is the `CodexRuntime` (id `codex`)

#### Scenario: The persistence lookup actually returns the stored runtime

- **WHEN** the real `PrismaProvisionLookup.getTaskRuntime(taskId)` is invoked against a persistence client holding `runtime = "claude-code"` for that task
- **THEN** it returns `"claude-code"` (proving the read path the DOA bug omitted is wired and exercised)

#### Scenario: Omitting getTaskRuntime from a lookup implementation is a build-time failure

- **WHEN** a `ProvisionLookup` implementation does not provide `getTaskRuntime`
- **THEN** the type check fails at build time (the registry depends on the required port member), rather than the registry silently defaulting every task to codex at run time

#### Scenario: An unresolvable runtime is logged, never silently defaulted

- **WHEN** the registry cannot resolve a task's runtime because the lookup is unwired, the lookup throws, or the stored value is outside the known set
- **THEN** the registry logs the fallback to the codex default at `warn` level (it does not swallow the condition silently)
