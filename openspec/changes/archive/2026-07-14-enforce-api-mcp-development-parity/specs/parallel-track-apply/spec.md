## ADDED Requirements

### Requirement: Apply correction respects semantic surface coupling

Before implementation, the apply correction step SHALL read
`surface-impact.json` in addition to file coupling. Registry, Public V1, MCP,
OpenAPI, and Playground tasks that implement the same semantic capability SHALL
be consolidated into one track or ordered through explicit dependencies even
when their code files do not overlap.

#### Scenario: Separate files share one public capability

- **WHEN** draft tracks put a registry edit and its MCP adapter in independent
  tracks solely because they touch different files
- **THEN** correction co-locates them or adds an explicit dependency before any
  implementation begins

### Requirement: Task completion requires its declared verifier

The apply flow SHALL resolve each task's verifier id through a repository-owned
allowlist and SHALL run that verifier after implementation. It MUST change a task
from `[ ]` to `[x]` only after the verifier exits zero. Unknown verifier ids,
missing metadata, and failed verification SHALL leave the task incomplete. The
apply flow MUST NOT execute arbitrary shell text read from `tasks.md`.

#### Scenario: Task verifier fails

- **WHEN** implementation is present but the task's allowlisted verifier exits
  non-zero
- **THEN** the apply flow repairs the defect or leaves the task `[ ]`
- **AND** it does not report that task complete

#### Scenario: Markdown contains a raw command

- **WHEN** task metadata contains a shell command instead of an allowlisted
  verifier id
- **THEN** metadata validation rejects it without executing the command

### Requirement: Integrated tracks rerun affected surface parity

The apply flow SHALL run the focused public-surface command after each track that
affects a public surface is integrated and before dependent tracks proceed.
After all tracks merge, it SHALL run `pnpm verify:public-surface` before the
broader project build/test command. A serial fallback or a small change SHALL
run the same applicable task and final gates.

#### Scenario: One track leaves MCP incomplete

- **WHEN** an integrated API/registry track passes its narrow tests but leaves a
  mapped MCP adapter incomplete
- **THEN** the focused integration gate exits non-zero and apply does not report
  success

#### Scenario: Small serial change cannot bypass parity

- **WHEN** a public-surface change has fewer tasks than the parallel threshold
- **THEN** serial apply still runs each declared verifier and the final
  public-surface gate
