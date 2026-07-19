# @cap/sandbox-core

Provider-neutral sandbox core contracts for CAP.

This package owns the low-level vocabulary shared by every sandbox adapter:

- capability names and operation-specific required capability sets;
- local/cloud provider locations;
- sandbox execution modes;
- provider ports and connection/result shapes;
- provider descriptors and local/cloud descriptor helpers;
- provider-neutral error types;
- immutable resource/workspace plans and exact-host redacted Git credentials;
- the provider-private mode-0600 secret-file write/delete port;
- the deprecated `GitCloneSpec` compatibility shape used during staged migration.

It intentionally contains no scheduler, lifecycle policy, workspace transport,
Nest, Docker, or cloud client code.

The stable contracts are:

- capability vocabulary and required-capability helpers;
- execution modes, provider locations, and provider descriptors;
- `SandboxProviderPort` and optional descriptor/readoption ports;
- selected-run, terminal, command, workspace, retention, and preflight descriptors;
- normalized command executor result shapes whose success proves process
  settlement and complete stdout/stderr drain, including zero-byte output;
- typed output-settlement rejections that map to the existing safe command
  transport, protocol, timeout, and cancellation classifications;
- secret-free ordinary/workspace command request types;
- provider-neutral configuration, selection, and capability errors.
