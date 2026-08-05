## ADDED Requirements

### Requirement: A closed diagnostics write gate is an injected no-op, not a branch at every call site

Whether provisioning diagnostics are written SHALL be a property of the injected implementation, not
a condition the orchestrator evaluates. The two orchestrator wrappers that today read the gate and
the recorder into locals, check `isEnabled()`, and return early SHALL move whole into the
`task-provisioning-diagnostics` context behind a `*.port.ts` interface and its DI token; a closed
gate SHALL be expressed there by returning the same "no observer" result the orchestrator used to
compute for itself. The orchestrator SHALL be left unable to tell an open gate from a closed one.

The gate's existing fail-closed semantics SHALL be preserved exactly, including its asymmetry: when
the gate is absent or throws, no diagnostic observer is begun and no downstream read is attempted.
Moving the decision SHALL NOT convert a closed gate into an open one on any path, and SHALL NOT make
the write timeout, the swallow-and-continue behaviour, or the returned shape observable differently
by the orchestrator.

The two constructor parameters SHALL remain, because the orchestrator still passes both into the
legacy inline-admission adapter. Removing them is a different change with a different blast radius.

#### Scenario: The orchestrator no longer evaluates the gate

- **WHEN** `guardrails.service.ts` is searched for reads of the write gate
- **THEN** the only surviving references are the constructor parameter and the legacy pass-through;
  no method in the orchestrator calls `isEnabled()` or branches on the gate's state

#### Scenario: A closed gate produces exactly the pre-change outcome

- **WHEN** provisioning is exercised with the gate closed, with the gate absent, and with the gate
  throwing from `isEnabled()`
- **THEN** in all three cases no diagnostic observer is begun, no diagnostic row is written, and the
  provisioning path completes exactly as it did before the move

#### Scenario: An open gate still records through the same seam

- **WHEN** provisioning is exercised with the gate open, for both the begin and the resume path
- **THEN** the same diagnostic observations are recorded as before the move, under the same attempt
  identity, and the write timeout still bounds them

#### Scenario: Consumers reach the owner only through its port

- **WHEN** imports of the new owner from outside its directory are listed, excluding composition
  files
- **THEN** each names the `*.port.ts` file and none names the owner's `*.service.ts`
