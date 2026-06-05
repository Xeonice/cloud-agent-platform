## MODIFIED Requirements

### Requirement: SandboxConnection handle returned from provisioning
The `AioSandboxProvider.provision()` SHALL return a `SandboxConnection` handle carrying `taskId`, an HTTP `baseUrl` of the form `http://cap-aio-<taskId>:8080`, and a `wsUrl` of the form `ws://cap-aio-<taskId>:8080/v1/shell/ws`, so that the orchestrator can address the sandbox by container name over `cap-net` and open the terminal WebSocket. The provider SHALL also clone the task repository into a DEDICATED, EMPTY workspace directory (e.g. `/home/gem/workspace`) — never into the non-empty `/home/gem` HOME — via `POST /v1/shell/exec` before returning the handle. The provider SHALL PARSE the `/v1/shell/exec` response body, treating a non-zero command `exit_code` (not merely a non-`ok` HTTP status) as a provisioning failure, and SHALL surface a real provision error rather than logging success on a silent clone failure.

The clone success path and the clone fail-closed path SHALL be VERIFIED END-TO-END on a live compose stack (not merely unit-tested), as fossilized black-box regression scenarios in the compose e2e suite (`apps/api/test/aio-e2e.mjs` + `scripts/aio-e2e.sh`): cloning into the dedicated empty workspace directory SHALL succeed with an asserted zero `exit_code`; a FORCED clone failure (non-empty target directory or bad repository URL) SHALL raise a non-zero exit_code with NO silent success. The `AioApprovalEnforcer` exec-gate is NOT verified end-to-end in this change: the enforcer class is fail-closed (covered by unit tests) but is currently DORMANT — there are no cap-owned gated `/v1/shell/exec` call sites in production code that route through it (it is wired as a DI provider for future use); see the `agent-events-and-approvals` spec for the honest coverage statement.

#### Scenario: Provision returns an addressable connection handle
- **WHEN** provisioning completes for task `<taskId>`
- **THEN** the returned `SandboxConnection` has `taskId` set, `baseUrl` equal to `http://cap-aio-<taskId>:8080`, and `wsUrl` equal to `ws://cap-aio-<taskId>:8080/v1/shell/ws`

#### Scenario: Task repository is cloned into a dedicated empty workspace dir before the handle is returned
- **WHEN** the sandbox is ready and before `provision()` returns
- **THEN** the provider issues a git clone of the task repository into a dedicated, empty workspace directory (e.g. `/home/gem/workspace`) via `POST /v1/shell/exec`
- **AND** it does NOT clone into the non-empty `/home/gem` HOME directory

#### Scenario: Clone failure surfaces a provision error instead of silent success
- **WHEN** the `POST /v1/shell/exec` clone command returns a non-zero `exit_code` in its response body (for example because the destination already exists or is non-empty)
- **THEN** the provider parses the response `exit_code`/`output` and raises a provisioning error
- **AND** it does NOT log "cloned task repository" or otherwise report success on a failed clone

#### Scenario: Clone success is verified end-to-end on a live compose stack
- **WHEN** the compose e2e suite (`apps/api/test/aio-e2e.mjs` + `scripts/aio-e2e.sh`) provisions a real sandbox and clones the task repository into the dedicated empty `/home/gem/workspace` via `POST /v1/shell/exec`
- **THEN** the clone command returns a zero `exit_code` and the e2e assertion passes that the repository is present in the workspace directory
- **AND** no provisioning error is raised on the success path

#### Scenario: Forced clone failure fails closed end-to-end with no silent success
- **WHEN** the compose e2e suite forces a clone failure (a non-empty target directory or a bad repository URL) via `POST /v1/shell/exec`
- **THEN** the provider parses the non-zero `exit_code` and the e2e suite observes a real provisioning error
- **AND** the suite asserts there is NO "cloned task repository" / silent success log on the failed clone

#### Scenario: Enforcer exec-gate class is fail-closed; no live gated call site exists
- **WHEN** the `AioApprovalEnforcer` class is evaluated for its fail-closed contract
- **THEN** the class resolves `allow` to `allowed:true`, and resolves `deny`, an approval error, or decision timeout to `allowed:false` (fail closed) — covered by unit tests
- **AND** this contract is NOT currently exercised end-to-end: there are no cap-owned gated `/v1/shell/exec` call sites in production code that route through the enforcer; it is registered as a DI provider (`AIO_APPROVAL_ENFORCER`) for future use but is dormant
- **AND** the spec does NOT claim this gate is live in the current production stack

### Requirement: codex launched in-shell over the terminal channel
The system SHALL launch codex INSIDE the AIO shell over the `/v1/shell/ws` terminal channel (execution model A), preserving the interactive TUI, and SHALL NOT run codex via the request/response `exec`/MCP surfaces for the interactive terminal channel. The derived sandbox image SHALL be baked FROM the pinned AIO image with codex, `~/.codex/hooks.json`, and the compiled `dist/hooks` included. The provisioned codex version SHALL be PINNED via a documented `CODEX_VERSION` build-arg to a release compatible with the account model in use (verified working: codex `0.131.0` with model `gpt-5.5`); the prior `0.42.0` pin SHALL NOT be used because it 400s on `gpt-5`/`gpt-5-codex`/`o4-mini` for ChatGPT accounts and is unusable with `gpt-5.5`. The baked `~/.codex/hooks.json` and the compiled `dist/hooks` SHALL conform to the codex `0.131` hook protocol.

The derived image SHALL be SLIMMED: instead of COPYing the whole built `/repo` workspace (so the hooks' pnpm symlink farm resolves at runtime), the build SHALL use `pnpm deploy` (`--prod`; `--legacy` if pnpm 10 requires it) to generate a SELF-CONTAINED `node_modules` tree for `@cap/sandbox-hooks`, and the image SHALL COPY only that self-contained `node_modules` plus the compiled `dist` — dropping the full `/repo` COPY. The slimmed image SHALL still resolve the hook dependencies at runtime: `import zod` and `@cap/contracts` SHALL load without `ERR_MODULE_NOT_FOUND` and the hook SHALL still run.

#### Scenario: codex runs over the interactive terminal channel
- **WHEN** a task begins execution
- **THEN** codex is started inside the AIO shell over the `/v1/shell/ws` terminal channel
- **AND** codex is not launched through the request/response `exec` or MCP surfaces for the interactive terminal channel

#### Scenario: Derived image bakes a compatible pinned codex and 0.131-format hooks
- **WHEN** the derived sandbox image is inspected
- **THEN** it is built FROM the pinned AIO image and includes codex, `~/.codex/hooks.json`, and the compiled `dist/hooks`
- **AND** the codex version is set from a documented `CODEX_VERSION` build-arg pinned to a release compatible with the account model (e.g. `0.131.0` for `gpt-5.5`), not `0.42.0`
- **AND** the baked `~/.codex/hooks.json` is in the codex `0.131` hook format

#### Scenario: Derived image uses pnpm deploy for a real, self-contained node_modules (no /repo COPY, no symlinks)
- **WHEN** the derived sandbox image build for `@cap/sandbox-hooks` is inspected
- **THEN** it uses `pnpm deploy` (`--prod --legacy`) to produce a self-contained `node_modules` tree and COPYs only that tree plus the compiled `dist` into `/opt/cap/`
- **AND** it does NOT COPY the full built `/repo` workspace into the final stage, and `/opt/cap/dist` is a real directory (no symlink indirection)
- **AND** the hook deps (`zod`, `@cap/contracts`) resolve as real, hoisted entries in the deploy tree with no dangling symlinks or `ERR_MODULE_NOT_FOUND`
- **NOTE** the structural change is the goal (real node_modules, no symlink farm, no /repo COPY); the overall image size is comparable to the prior approach because the hooks-build stage was already a selective workspace COPY, not the full host repo

#### Scenario: Hook dependencies still resolve at runtime in the slimmed image
- **WHEN** the slimmed derived image runs the baked hook
- **THEN** `import zod` and `@cap/contracts` resolve without `ERR_MODULE_NOT_FOUND`
- **AND** the hook executes successfully
