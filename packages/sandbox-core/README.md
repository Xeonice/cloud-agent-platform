# @cap/sandbox-core

Provider-neutral sandbox core contracts for CAP.

This package owns the low-level vocabulary shared by every sandbox adapter:

- capability names and operation-specific required capability sets;
- local/cloud provider locations;
- sandbox execution modes;
- provider ports and connection/result shapes;
- provider descriptors and local/cloud descriptor helpers;
- provider-neutral error types;
- the `GitCloneSpec` value object used by workspace materialization callers.

It intentionally contains no scheduler, lifecycle policy, workspace transport,
Nest, Docker, or cloud client code.

The stable contracts are:

- capability vocabulary and required-capability helpers;
- execution modes, provider locations, and provider descriptors;
- `SandboxProviderPort` and optional descriptor/readoption ports;
- selected-run, terminal, command, workspace, retention, and preflight descriptors;
- normalized command executor result shapes;
- provider-neutral configuration, selection, and capability errors.
