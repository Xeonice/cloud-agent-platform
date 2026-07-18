# @cap/sandbox-conformance

Framework-neutral provider conformance scenarios.

Adapters can reuse this package from any test runner by passing an assertion
adapter. The suite checks declared capabilities, provision handles, existence,
workspace delivery result shape, retained transcript shape, readoption surfaces,
and teardown callability.

Provider families opt into executable capability checks separately through
`createSandboxProviderBehaviorConformanceScenarios`. The provider test harness
supplies real terminal and command handles plus closed behavior traces; the
conformance suite itself drives and verifies attach, output, input, resize,
close/replacement, command settlement, staged materialization/delivery, exact
provider-sandbox ownership fencing, and readoption order for one selected task.
Every trace event carries a contiguous sequence and the selected task/provider
identity, so a callback or descriptor alone cannot satisfy behavioral
conformance. The baseline suite remains backward compatible while AIO,
cloud-http, and BoxLite adopt their actual fake transports and owner seams.

Diagnostic conformance is additive and opt-in through
`createSandboxProviderDiagnosticConformanceScenarios`. It supplies a deterministic
task-scoped emitter plus safe task/attempt identity, or an explicitly
non-persisting taskless observer, to a provider-owned exercise callback. Task
inputs can be composed directly into `SandboxProvisionContext` without exposing
the recorder. Task emitters start with provider family `unknown`; the real
provider must bind its own family before any task scenario can pass. The suite
then verifies bounded start/terminal pairs, stable correlation, create/inspect
replay deduplication, create timeout/cancellation/indeterminate outcomes, independent
primary and cleanup failures, credential-cleanup evidence, recorder-failure
isolation, and raw-provider/secret-canary absence. Callers must declare one closed
`workspaceCredential` mode from the provider's real capabilities. Providers with
`workspace.git.materialize` or `workspace.git.deliver` prove provider-local secret
cleanup; providers without both capabilities instead prove canonical credentials
are rejected before any external boundary, with no synthetic diagnostic events.
Provider-family adoption stays separate so adapters without diagnostic wiring
continue to use the baseline suite.
