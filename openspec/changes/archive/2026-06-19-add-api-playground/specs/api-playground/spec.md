## ADDED Requirements

### Requirement: The API Playground page renders a catalog + request/response columns

The `/api` page (under the authed `_app` shell) SHALL render, faithful to the `screens/api.html` design: a left endpoint **rail** (a searchable list of `/v1` endpoints grouped by domain) and a right column with a **request** section (method + URL + 发送) and a **response** section. Selecting an endpoint in the rail SHALL load it into the request section.

#### Scenario: Selecting an endpoint loads it into the request editor

- **WHEN** the operator opens `/api` and clicks an endpoint in the rail
- **THEN** the request section shows that endpoint's method + path and the request editor is populated for it

### Requirement: The catalog is the curated, real /v1 surface

The endpoint catalog SHALL list the REAL applied `/v1` endpoints: `POST /v1/tasks`, `GET /v1/tasks`, `GET /v1/tasks/:id`, `POST /v1/tasks/:id/stop`, `GET /v1/tasks/:id/transcript`, `GET /v1/repos`, `GET /v1/repos/:id`, and `GET /v1/openapi.json`; the SSE `GET /v1/tasks/:id/events` SHALL be present as a distinct STREAMING entry. The playground SHALL call ONLY these curated paths — it SHALL NOT expose an arbitrary/free-form URL field (no open fetch box), so it can never be turned into an SSRF-style request tool. Endpoints with a `:id` (or other path) parameter SHALL surface an input for that parameter, substituted into the path before sending.

#### Scenario: Only curated /v1 paths are reachable

- **WHEN** the operator uses the playground
- **THEN** every request targets a path from the curated `/v1` catalog (with its path params filled), and there is no free-form URL field that would allow an arbitrary host/path

#### Scenario: A path parameter is filled before sending

- **WHEN** the operator selects `GET /v1/tasks/:id` and supplies an id
- **THEN** the id is substituted into the path and the sent request targets `/v1/tasks/<id>`

### Requirement: Requests execute for real, signed by the operator session

A 发送 action SHALL execute the request FOR REAL against the running api through the existing authed transport — `credentials: "include"` plus the operator bearer the web already attaches — so the request is signed by the operator's CONSOLE SESSION with NO token to paste. The playground SHALL NOT prompt for or accept a manually-entered token. The response (status, status text, elapsed time, size, headers, and body) SHALL be captured and shown. Because the page is behind the `_app` auth gate, only an authenticated operator can send. Destructive writes (`POST /v1/tasks`, `POST /v1/tasks/:id/stop`) run as the operator under the shared-pool model.

#### Scenario: A sent request is signed by the session and rendered

- **WHEN** the operator sends a catalog request
- **THEN** it executes against the running api carrying the operator's session credentials (no pasted token), and the response status + timing + headers + body are rendered

#### Scenario: No manual token entry

- **WHEN** the operator views the request auth
- **THEN** the page shows the request is session-signed (OAuth auto-injected) and offers no field to paste a token

### Requirement: Request editor with Body / Params / Headers and response viewer

The request section SHALL provide a Body tab (a JSON editor with a 格式化 action) for write endpoints, a Params tab (query parameters, e.g. `limit`/`cursor` for the list endpoints), and a Headers tab showing the auto-injected `Authorization` (masked) + `Content-Type` (read-only). The response section SHALL show a status pill (e.g. `201 Created`), an elapsed-time + size meta, and Body / Headers tabs rendering the actual response (the body pretty-printed when JSON). An in-flight send SHALL show a pending state; a failed send (network/api unreachable) SHALL render the error in the response section rather than crashing.

#### Scenario: A JSON body is edited, formatted, and sent

- **WHEN** the operator edits the JSON body of `POST /v1/tasks`, formats it, and sends
- **THEN** the request carries that body and the response section shows the status, timing, and the (pretty-printed) response body

#### Scenario: A failed send surfaces an error, not a crash

- **WHEN** a send fails (api unreachable or a non-2xx)
- **THEN** the response section renders the error/status honestly and the page stays usable

### Requirement: The SSE events endpoint has a streaming view

The catalog's `GET /v1/tasks/:id/events` entry SHALL be presented as a STREAMING endpoint (not a single request/response): sending it SHALL open a live tail that appends each received `text/event-stream` event, with a control to stop/close the stream. It SHALL be visually + behaviorally distinct from the request/response endpoints.

#### Scenario: The events endpoint streams a live tail

- **WHEN** the operator sends `GET /v1/tasks/:id/events` for a task id
- **THEN** a live tail appends incoming SSE lifecycle events until the stream closes or the operator stops it, distinct from the single-response endpoints
