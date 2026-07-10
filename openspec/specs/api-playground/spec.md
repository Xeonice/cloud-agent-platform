# api-playground Specification

## Purpose
Provide an authenticated in-console client for exercising the exact public `/v1`
data surface without exposing an arbitrary URL fetcher, while keeping request
examples and route metadata aligned with the shared API contracts.
## Requirements
### Requirement: The API Playground page renders a catalog + request/response columns

The `/api` page (under the authed `_app` shell) SHALL render, faithful to the `screens/api.html` design: a left endpoint **rail** (a searchable list of `/v1` endpoints grouped by domain) and a right column with a **request** section (method + URL + 发送) and a **response** section. Selecting an endpoint in the rail SHALL load it into the request section.

#### Scenario: Selecting an endpoint loads it into the request editor

- **WHEN** the operator opens `/api` and clicks an endpoint in the rail
- **THEN** the request section shows that endpoint's method + path and the request editor is populated for it

### Requirement: The catalog is the curated, real /v1 surface

The data-operation catalog SHALL be generated from the shared
`PUBLIC_V1_OPERATIONS` manifest and SHALL contain every real public `/v1` data
operation exactly once: the task, repository, and scheduled-task operations,
including the task SSE stream and all schedule list/create/read/update/pause/
resume/dispatch/delete/run-ledger operations. `GET /v1/openapi.json` and
`GET /v1/docs` SHALL be available as separate documentation entries and SHALL NOT
be counted as data operations. Internal callbacks such as sandbox approvals SHALL
NOT appear in the catalog. A drift test SHALL compare the catalog's data operation
ids and `(method, path)` pairs exactly with the shared manifest.

The playground SHALL call ONLY these curated paths. It SHALL NOT expose an
arbitrary/free-form URL field, so it cannot be turned into an SSRF-style request
tool. Endpoints with a `:id` or other path parameter SHALL surface an input for
that parameter, URL-encode it, and SHALL NOT send until every required path
parameter is filled.

#### Scenario: Only curated /v1 paths are reachable

- **WHEN** the operator uses the playground
- **THEN** every request targets a path from the curated `/v1` catalog (with its path params filled), and there is no free-form URL field that would allow an arbitrary host/path

#### Scenario: A path parameter is filled before sending

- **WHEN** the operator selects `GET /v1/tasks/:id` and supplies an id
- **THEN** the id is substituted into the path and the sent request targets `/v1/tasks/<id>`

#### Scenario: A missing path parameter blocks sending

- **WHEN** the selected operation requires an id and the operator has not supplied it
- **THEN** the page shows a validation error and emits no network request

### Requirement: Requests execute for real, signed by the operator session

A 发送 action SHALL execute the request FOR REAL against the running api through
the existing authed transport. The browser SHALL send `credentials: "include"`
so the operator's console-session cookie is carried; the optional configured
legacy bearer MAY also be attached by the shared transport. The playground SHALL
NOT prompt for or accept a manually-entered token. The response (status, status
text, elapsed time, size, headers, and body) SHALL be captured and shown. Because
the page is behind the `_app` auth gate, only an authenticated operator can send.
Every operation marked destructive by the shared manifest SHALL require the
existing confirmation before sending.

#### Scenario: A sent request is signed by the session and rendered

- **WHEN** the operator sends a catalog request
- **THEN** it executes against the running api carrying the operator's session credentials (no pasted token), and the response status + timing + headers + body are rendered

#### Scenario: No manual token entry

- **WHEN** the operator views the request auth
- **THEN** the page shows that the session Cookie is automatic and a legacy
  Bearer is optional, and offers no field to paste a token

### Requirement: Request editor with Body / Params / Headers and response viewer

The request section SHALL provide a Body tab (a JSON editor with a 格式化 action)
for body-bearing write endpoints, a Params tab (`limit` SHALL reflect the shared
default of 50 and `cursor` SHALL remain optional), and a Headers tab. Authentication
and content type SHALL remain read-only and automatically injected; an operation's
explicit protocol headers SHALL be editable. In particular, `POST /v1/tasks` SHALL
allow an optional `Idempotency-Key` so retry semantics can be verified in-console.
Every sample body SHALL parse successfully with the operation's shared request
schema. A malformed JSON editor value SHALL show a validation error and SHALL NOT
be silently converted into a JSON string or sent. The response section SHALL show
a status pill, elapsed time, size, and Body / Headers tabs rendering the actual
response. An in-flight send SHALL show a pending state; a failed send SHALL render
the error in the response section rather than crashing.

#### Scenario: A JSON body is edited, formatted, and sent

- **WHEN** the operator edits the JSON body of `POST /v1/tasks`, formats it, and sends
- **THEN** the request carries that body and the response section shows the status, timing, and the (pretty-printed) response body

#### Scenario: Invalid JSON blocks sending

- **WHEN** the body editor does not contain valid JSON
- **THEN** the page shows a validation error and emits no network request

#### Scenario: A failed send surfaces an error, not a crash

- **WHEN** a send fails (api unreachable or a non-2xx)
- **THEN** the response section renders the error/status honestly and the page stays usable

### Requirement: The SSE events endpoint has a streaming view

The catalog's `GET /v1/tasks/:id/events` entry SHALL be presented as a STREAMING
endpoint (not a single request/response): sending it SHALL open a live tail that
appends each received `text/event-stream` event, with a control to stop/close the
stream. The stream transport SHALL carry the same session credentials as ordinary
playground requests and SHALL expose the optional `Last-Event-ID` header so an
operator can resume after a known event. SSE framing SHALL be parsed by a
standards-compliant parser rather than treating the HTTP body as one JSON object.
It SHALL be visually + behaviorally distinct from the request/response endpoints.

#### Scenario: The events endpoint streams a live tail

- **WHEN** the operator sends `GET /v1/tasks/:id/events` for a task id
- **THEN** a live tail appends incoming SSE lifecycle events until the stream closes or the operator stops it, distinct from the single-response endpoints

#### Scenario: The events stream resumes from a supplied event id

- **WHEN** the operator supplies `Last-Event-ID` before opening the events stream
- **THEN** the request sends that header and the live tail begins after the
  corresponding persisted lifecycle event
