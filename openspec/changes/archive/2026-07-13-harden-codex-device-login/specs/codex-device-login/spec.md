## ADDED Requirements

### Requirement: Device login begins as an asynchronous account-scoped session
The system SHALL expose official Codex device login as a session-scoped asynchronous operation. POST /settings/codex/device-login SHALL create or recover the authenticated account's single active attempt, assign an opaque sessionId before any worker preparation begins, and return HTTP 202 with a shared-contract response containing that sessionId and status preparing. The start request SHALL NOT wait for container readiness, Codex startup, or device-code issuance before responding. Every device-login success or error response, including DELETE, SHALL be non-cacheable.

#### Scenario: Start returns before device-code preparation
- **WHEN** an authenticated account starts official Codex device login while the login worker still needs to start
- **THEN** the API returns HTTP 202 with an opaque sessionId and status preparing without waiting for a verification URL or user code

#### Scenario: Retried start does not create a second worker
- **WHEN** the same account retries the start request while its prior attempt is still nonterminal
- **THEN** the API returns that account's existing active session and does not create a second login worker

#### Scenario: Identity-less principal cannot create a session
- **WHEN** a principal without an account identity calls the device-login start endpoint
- **THEN** the API rejects the request and creates no login session or temporary worker

#### Scenario: Device-login responses are not cached
- **WHEN** the API returns any start, status, cancellation, or error response for device login
- **THEN** the response carries Cache-Control: no-store

### Requirement: Codex App Server provides structured device authorization
The login worker SHALL delegate OpenAI device authorization and token polling to the pinned Codex App Server protocol over its newline-delimited stdio JSON transport. It SHALL initialize the protocol and invoke account/login/start with type chatgptDeviceCode, then map the returned loginId, verificationUrl, and userCode to the owning CAP session without parsing human-facing terminal output, hard-coding the verification URL, constructing a code-bearing URL, or calling OpenAI's internal device endpoints directly. The system SHALL bound protocol initialization and device-code preparation; a worker exit, malformed response, or timeout SHALL transition the session to error and reclaim temporary resources.

#### Scenario: Structured device code becomes awaiting authorization
- **WHEN** Codex App Server returns a chatgptDeviceCode result for the active attempt
- **THEN** the CAP session transitions from preparing to awaiting_authorization and exposes the returned verificationUrl and userCode to that account

#### Scenario: Human CLI text is not an integration contract
- **WHEN** Codex changes ANSI styling or human-readable wording produced by codex login
- **THEN** CAP device login remains unaffected because it consumes the App Server JSON protocol and performs no URL or device-code log regex parsing

#### Scenario: Preparation failure is bounded and observable
- **WHEN** the temporary worker cannot start, App Server initialization fails, its response is invalid, or the preparation deadline elapses
- **THEN** the session transitions to error with a secret-free operator message and every resource for that attempt is reclaimed

### Requirement: Login lifecycle is cancellable, isolated, and race-safe
The shared device-login contract SHALL represent preparing, awaiting_authorization, finalizing, connected, cancelled, expired, and error states. GET and DELETE SHALL address an explicit sessionId and SHALL resolve it only within the authenticated account's scope. Cancellation SHALL mark the session cancelled before asynchronous worker cleanup, SHALL invoke account/login/cancel when a Codex loginId exists, and SHALL terminate the worker when it does not. Every asynchronous state update SHALL verify that the attempt is still current and nonterminal, so a cancelled, expired, or superseded attempt cannot publish a late code, store a credential, or overwrite a newer attempt. DELETE SHALL be idempotent.

#### Scenario: Preparing attempt can be cancelled
- **WHEN** the account cancels its session while container or App Server preparation is still running
- **THEN** the session becomes cancelled immediately, the worker is stopped and reclaimed, and any later preparation result is ignored

#### Scenario: Awaiting attempt cancels the Codex login
- **WHEN** the account cancels an awaiting_authorization session that has a Codex loginId
- **THEN** CAP requests account/login/cancel, reclaims the worker, and retains cancelled as the terminal outcome

#### Scenario: Late completion cannot overwrite a retry
- **WHEN** an older attempt reports a code or completion after it was cancelled or after the account created a newer attempt
- **THEN** the stale update is rejected by the session attempt guard and the newer session and stored credential remain unchanged

#### Scenario: Account cannot observe or cancel another account's attempt
- **WHEN** account A requests GET or DELETE using a sessionId owned by account B
- **THEN** the API reveals no session state and does not alter account B's worker

#### Scenario: Poll throttling alone does not expire a valid session
- **WHEN** browser background throttling delays GET requests while the server-side session deadline has not elapsed
- **THEN** the session remains active and is not reclaimed solely because a frontend poll was absent

#### Scenario: Session deadline and shutdown reclaim resources
- **WHEN** a session reaches its CAP-managed deadline, the API module shuts down, or a subsequent API start discovers a labelled worker left by an ungraceful exit
- **THEN** all container, exec, stream, timer, and in-memory resources for that attempt are reclaimed and no discovered worker is left orphaned

### Requirement: Successful completion persists the official credential securely
After account/login/completed reports success, the session SHALL transition to finalizing while CAP obtains the credential from the temporary Codex home and saves it through the existing encrypted per-account SettingsService boundary. The worker SHALL explicitly select Codex's file credential store. The session SHALL become connected only after a structurally valid credential has been persisted successfully; protocol, credential-read, validation, or persistence failure SHALL produce error, preserve any previously stored credential, and reclaim the worker. Device codes, auth.json contents, access tokens, and refresh tokens SHALL NOT be written to application logs, error responses, or caches, and temporary authentication material SHALL be destroyed on every terminal path.

#### Scenario: Completion is connected only after encrypted persistence
- **WHEN** App Server reports successful login and CAP validates and saves the resulting official credential
- **THEN** the session transitions through finalizing to connected and the account's official credential is available through the existing settings read model

#### Scenario: Persistence failure does not report a false connection
- **WHEN** App Server reports success but credential reading, validation, or encrypted persistence fails
- **THEN** the session transitions to error, does not report connected, and leaves the account's previously stored credential unchanged

#### Scenario: Tokenless credential scaffold is rejected
- **WHEN** the temporary Codex home contains auth JSON with only auth_mode or with null/missing ChatGPT tokens
- **THEN** CAP rejects it as an invalid credential, stores nothing, and transitions the session to error

#### Scenario: Authentication material is absent from diagnostics
- **WHEN** the login succeeds, fails, expires, or is cancelled
- **THEN** application logs and client-visible errors contain lifecycle identifiers and secret-free diagnostics only, never the user code or credential material

### Requirement: CAP reports an honest local session deadline
The API SHALL describe expiry as a CAP-managed login-session deadline and SHALL NOT present a hard-coded value as the authoritative OpenAI device-code lifetime. When that deadline passes before successful completion, the server SHALL atomically transition the attempt to expired, cancel or terminate the worker, and make the terminal state queryable without retaining authentication material.

#### Scenario: Local deadline expires an unfinished attempt
- **WHEN** the CAP login-session deadline passes while the attempt is preparing or awaiting authorization
- **THEN** the session transitions to expired, its worker is reclaimed, and the status response describes the CAP session expiry without claiming an OpenAI-provided lifetime
