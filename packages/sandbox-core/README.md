# @cap/sandbox-core

Provider-neutral sandbox core contracts for CAP.

This package owns the low-level vocabulary shared by every sandbox adapter:

- capability names and operation-specific required capability sets;
- local/cloud provider locations;
- sandbox execution modes;
- provider ports and connection/result shapes;
- provider descriptors and local/cloud descriptor helpers;
- the `GitCloneSpec` value object used by workspace materialization callers.

It intentionally contains no scheduler, lifecycle policy, workspace transport,
Nest, Docker, or cloud client code.
