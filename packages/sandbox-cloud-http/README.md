# @cap-console/sandbox-cloud-http

HTTP cloud sandbox provider adapter for CAP.

This package is the managed/cloud counterpart to local provider adapters such as
the current AIO/Docker provider in `apps/api`. It implements the
`SandboxProviderPort` contract from `@cap-console/sandbox` and registers as a cloud
candidate through `defineHttpCloudSandboxProvider`.

## Control Plane Contract

The adapter expects a CAP-compatible cloud sandbox control plane implementing
these 7 required endpoints:

- `POST /v1/sandboxes`
  - body: `{ taskId, cloneSpec? }`
  - response: `{ data: { taskId, baseUrl, wsUrl } }`
- `DELETE /v1/sandboxes/:taskId`
  - `404` is treated as idempotent success.
- `GET /v1/sandboxes/:taskId`
  - `2xx` means present, `404` means absent.
- `GET /v1/sandboxes/:taskId/transcript?runtimeId=...`
  - response: `{ data: { format, jsonl } }`
  - `404`/`204` means no retained transcript.
- `POST /v1/sandboxes/:taskId/deliver`
  - body: `{ authHeader, branch, commitMessage }`
  - response: `{ data: { hadChanges, commitSha, error } }`
- `GET /v1/sandboxes/readoptable`
  - response: `{ data: string[] }`
- `POST /v1/sandboxes/:taskId/reattach`
  - response: `{ data: { taskId, baseUrl, wsUrl } }`

## Reference Server

`startHttpCloudSandboxReferenceServer` (exported from this package,
`src/reference-server.ts`) boots a real bound HTTP listener implementing every
required endpoint above. It is deliberately a **reference server, not a mock**:
executable documentation of this protocol, and the peer the conformance suite
runs against over real HTTP. If the server's handling of a required endpoint
and the provider's expectation diverge, conformance fails — a hand-written
fetch stub could silently mirror the provider's own assumptions while this
README drifted. Fetch stubs remain only beneath the server, for fault
injection (thrown transport errors, timeouts) that a protocol-conformant
listener cannot produce.

Placement ruling (unlock-extension-axes, task 6.1): the server lives
in-package rather than under `examples/`. `examples/` is outside the pnpm
workspace globs, so a server there would be a dead package that no build,
typecheck, or CI lane ever compiles; in-package it is built by this package's
`tsc` build and exercised by the `test` script that the CI `package-suites`
directory filter already discovers.

Reference semantics worth pinning:

- `POST /v1/sandboxes` is idempotent per task id; a replay naming a different
  `resourceGeneration` is refused with `409`.
- Ownership fencing is adopt-on-first-fence; once recorded, a mismatched
  `If-Match` fails closed with `412` and a mismatched `providerSandboxId`
  with `409`. Unfenced `DELETE` remains allowed (legacy compatibility).
- `DELETE` is an acknowledgement only; callers prove the terminal state with a
  follow-up `GET` (absence for `superseded-remove`, `status: "retained"` for
  `terminal-retain`).

## Optional Self-Description (additive)

- `GET /v1/self-description` → `{ data: { specificationVersion,
  supportedSpecificationVersions?, capabilities? } }`.
- The endpoint is a purely additive, optional extension. A server without it
  is a **baseline server**: `negotiateHttpCloudSpecification` resolves to a
  `baseline` outcome and every required-endpoint behavior works unchanged —
  absence is never an error.
- Version negotiation **counter-offers** instead of rejecting: when the server
  advertises a different preferred specification version, the outcome is a
  mutually supported version when one exists, and otherwise a typed
  `version-mismatch` result naming both sides' versions.
- Ruling (unlock-extension-axes, task 6.4 open question): the specification
  version is **not** embedded in the provider declaration object
  (`defineHttpCloudSandboxProvider`). Self-description is a connection-time
  discovery concern; keeping it out of the descriptor keeps baseline servers
  first-class and the declaration object version-agnostic.

## Capabilities

By default the adapter declares the full current capability set from
`@cap-console/sandbox`. Deployments can pass a narrower `capabilities` list when their
cloud backend does not support delivery, retained transcript reads, or
readoption.

Writing secret material stays a provider-local trust-boundary refusal: the two
secret-writer rejections (canonical workspace credentials at provision,
credentialed delivery) are asserted by the conformance suite against the real
reference server, and no request carrying secret material reaches its
listener.
