## ADDED Requirements

### Requirement: API Playground exposes model-aware public operations from the manifest

The API Playground catalog SHALL include the runtime-model query operation and
shall reflect the additive `model` field in direct task creation and nested
schedule task templates from the same public operation manifest and shared
schemas used by the wire. It SHALL display required `tasks:write` scope and the
documented 422/429/503 model/catalog errors. Dynamic model ids SHALL not be embedded
as a static editor enum or stale hardcoded example.

#### Scenario: Catalog operation is visible and executable

- **WHEN** an authenticated operator selects the runtime-model catalog entry
- **THEN** the Playground renders its runtime/environment request body, scope, response schema, and documented failures
- **AND** executing it sends a real signed request to `/v1/runtime-models/query`

#### Scenario: Task and schedule editors include model intent

- **WHEN** an operator opens task create, schedule create, or schedule update in the Playground
- **THEN** the editor schema accepts the optional bounded model string at the correct direct or nested location
- **AND** the response viewer shows nullable requested model fields returned by the real API

#### Scenario: Playground catalog parity catches omissions

- **WHEN** the public operation manifest gains the runtime-model query or its schemas change
- **THEN** catalog/column parity tests fail unless the Playground renders the operation and current request/response contracts

### Requirement: Playground failures remain faithful to the public API

The response viewer SHALL render the real safe error envelope and HTTP status
for model validation and catalog failures without replacing them with local
frontend validation or provider diagnostics.

#### Scenario: Unavailable model response is shown

- **WHEN** a real Playground task or schedule request receives `runtime_model_not_available`
- **THEN** the viewer shows HTTP 422 and the safe public error body

#### Scenario: Catalog outage response is shown

- **WHEN** a real Playground catalog or explicit-model request receives `runtime_model_catalog_unavailable`
- **THEN** the viewer shows HTTP 503 and retryable safe error data

#### Scenario: Catalog request throttle is shown

- **WHEN** a real Playground catalog query exceeds its principal request allowance
- **THEN** the viewer shows the documented HTTP 429 response and retry guidance
