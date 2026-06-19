## ADDED Requirements

### Requirement: Public OpenAPI metadata endpoints are unauthenticated

The global operator auth guard SHALL exempt `GET /v1/openapi.json` and `GET /v1/docs` from authentication — they expose only read-only API metadata (the generated OpenAPI document and its interactive viewer) and carry no secrets, exactly like the existing `/health` / `/version` public-metadata exemptions. Every OTHER `/v1` route SHALL remain guarded; the exemption SHALL be exact-match (never a `/v1` prefix match) so the data-plane `/v1` routes are never accidentally unauthenticated. The guarded `/v1` routes SHALL admit BOTH session and `api-key` principals through the existing `resolveOperatorPrincipal`, and the `/v1` controllers SHALL read the attached principal and `hasScope` to gate scoped operations.

#### Scenario: The OpenAPI doc is reachable without a credential

- **WHEN** an unauthenticated client requests `GET /v1/openapi.json` or `GET /v1/docs`
- **THEN** it is served (200) without an operator credential, like `/version`

#### Scenario: Data-plane /v1 routes stay guarded

- **WHEN** an unauthenticated client requests any `/v1` data route (e.g. `GET /v1/tasks`)
- **THEN** it is rejected with 401 — the exemption is exact-match on the two metadata paths only, never a `/v1` prefix

#### Scenario: /v1 admits both session and api-key principals

- **WHEN** a guarded `/v1` route is reached with a valid GitHub session OR a valid `cap_sk_` api-key
- **THEN** the request is admitted as the resolved principal and scoped operations are gated by `hasScope`
