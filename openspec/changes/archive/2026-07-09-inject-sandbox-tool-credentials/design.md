## Context

CAP now has admin-managed sandbox images under `SandboxEnvironment`. The image record is the natural control point for image-specific runtime parameters: the same image can declare that it needs `GCODE_TOKEN`, `GCODE_API_BASE_URL`, or internal package registry variables, and every task using that image receives the same admin-configured values.

The previous task-owner forge credential design made `gcode` work only by coupling image tools to repository identity and user forge credentials. That does not match the product model for custom images: only admins configure images, and image-specific service tokens are deployment/admin concerns.

Relevant existing behavior:

- `SandboxEnvironment` records are admin-only and already drive task image selection/defaulting.
- Environment read APIs are used by the Image Management UI and user default-image picker.
- AIO and BoxLite both run provider-neutral setup commands before launching the selected agent runtime.
- Sandbox run metadata and validation records must remain non-secret.

## Goals / Non-Goals

**Goals:**

- Add image-level runtime parameters managed in Image Management.
- Distinguish plain parameters from secret parameters.
- Keep secret values encrypted at rest and write-only on API/UI read paths.
- Inject parameters only for the selected/default environment used by the task.
- Provide a stable sandbox file that custom image wrappers can source.
- Clean up materialized parameters before retained sandbox stop/teardown.

**Non-Goals:**

- Build a generic user-level third-party credential center.
- Infer tool tokens from repository/forge credentials.
- Manage registry pull credentials.
- Validate whether a third-party token has sufficient external permissions.
- Provide per-user/per-task overrides in this change.

## Decisions

### 1. Store parameters on `SandboxEnvironment`

Image parameters belong to the admin-managed image record, not to users or tasks. The API stores:

- plain environment variables as JSON object key/value pairs.
- secret environment variables as JSON object key/encrypted-value pairs.

Read responses expose plain values and secret keys with `secret: true`, but never return secret values.

Alternative considered: a global third-party credential manager. Rejected as more complex than the current admin-managed image requirement.

### 2. Resolve parameters through `ProvisionLookup`

The provider packages should not know Prisma or encryption. During provisioning, the host harness asks `ProvisionLookup` for the selected task image parameter profile, passing provider family and runtime id. The API implementation resolves the explicit/default sandbox environment exactly like image selection and returns command-ready parameter material.

Alternative considered: include secret parameters inside `ResolvedSandboxEnvironment`. Rejected because resolved environment metadata is also used for run/audit metadata and must remain non-secret.

### 3. Materialize a CAP env file

CAP writes parameters to a standard file:

```text
/home/gem/.cap/image-env
```

The file contains shell-safe `export NAME='value'` lines and is mode `0600`. Custom image wrappers source this file before calling their tool.

Alternative considered: container-level env variables. Rejected as the default because provider create requests and process metadata are more likely to be captured or inspected.

### 4. Keep missing parameters non-fatal

If an environment has no parameters, provisioning continues and no file is written. If a required third-party parameter is missing, the tool or wrapper should fail with its own error. CAP should not infer every tool's required parameter contract in this change.

### 5. Clean up best-effort

AIO pre-stop and BoxLite teardown/readopt teardown remove `/home/gem/.cap/image-env` best-effort. Cleanup failure should log non-secret context and never block task settlement.

## Risks / Trade-offs

- [Shared image token scope] -> This model intentionally uses image-level shared tokens. It is suitable for admin-managed service tokens, not per-user identity.
- [Secret leakage through command output] -> Use base64 payload writes, shell-safe exports, known-secret output scrubbing, and write-only read responses.
- [No edit flow yet can make rotation awkward] -> The initial implementation should support parameter configuration at image registration; follow-up can add a dedicated edit/rotate endpoint if needed.
- [Wrapper contract becomes important] -> Document a stable file path and simple source pattern so custom images can integrate without CAP knowing each tool.

## Migration Plan

1. Add nullable/defaulted `env_vars` and `secret_env_vars` columns to `SandboxEnvironment`.
2. Extend contracts and service mapping for image parameters, preserving existing environments with empty parameter sets.
3. Add provider-neutral image parameter setup and cleanup helpers.
4. Wire AIO and BoxLite setup/cleanup through the host harness.
5. Update Image Management create form and custom image docs.
6. Verify with contract/service/provider tests and OpenSpec strict validation.
