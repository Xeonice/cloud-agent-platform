## ADDED Requirements

### Requirement: /v1 transcript surfaces the enriched transcript fields
The `GET /v1/tasks/:id/transcript` response SHALL surface the additive
session-history fields introduced for the transcript timeline — per-turn
timestamps, the `system` milestone turn kind, tool diffstat, and session totals —
serialized from the SAME `@cap/contracts` session-history schema the console
consumes. The additions SHALL be ADDITIVE and OPTIONAL so existing `/v1`
consumers are not broken, and the `GET /v1/openapi.json` document SHALL be
regenerated so it continues to describe the transcript response from the same
schemas used for validation (no drift). No new `/v2` surface is introduced.

#### Scenario: v1 transcript includes the new fields
- **WHEN** a scoped client requests `GET /v1/tasks/:id/transcript` for a task whose transcript carries the new data
- **THEN** the response includes the per-turn timestamps, any `system` turns, tool diffstat, and session totals, serialized from the shared session-history schema

#### Scenario: Additions are backward-compatible for existing consumers
- **WHEN** an existing `/v1` consumer reads a transcript response that omits the new optional fields (e.g. an old durable archive)
- **THEN** the response remains valid against the contract and the consumer is not broken

#### Scenario: OpenAPI document reflects the enriched transcript schema
- **WHEN** a client fetches `GET /v1/openapi.json` after this change
- **THEN** the transcript response schema in the document reflects the new optional fields, generated from the same zod schemas used for request/response validation
