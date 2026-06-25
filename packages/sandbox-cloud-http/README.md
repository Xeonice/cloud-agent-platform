# @cap/sandbox-cloud-http

HTTP cloud sandbox provider adapter for CAP.

This package is the managed/cloud counterpart to local provider adapters such as
the current AIO/Docker provider in `apps/api`. It implements the
`SandboxProviderPort` contract from `@cap/sandbox` and registers as a cloud
candidate through `defineHttpCloudSandboxProvider`.

## Control Plane Contract

The adapter expects a CAP-compatible cloud sandbox control plane:

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

## Capabilities

By default the adapter declares the full current capability set from
`@cap/sandbox`. Deployments can pass a narrower `capabilities` list when their
cloud backend does not support delivery, retained transcript reads, or
readoption.
