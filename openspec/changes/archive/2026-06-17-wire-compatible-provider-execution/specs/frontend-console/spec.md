## ADDED Requirements

### Requirement: Compatible-provider dialog is backed by real model discovery
The settings compatible-provider (api-key) dialog SHALL drive its connection test and model list from the **real** discovery endpoint (`POST /settings/codex/models`) via the shared `@cap/contracts` discovery schema, NOT from a hardcoded/mock model list or a client-only non-empty-field check. "测试连接/测试凭据" SHALL issue the real probe and reflect its actual outcome class (success vs auth-failure vs unreachable), the default-model picker SHALL be populated from the models the probe returns, and selecting a returned model SHALL be REQUIRED before the credential can be saved. The save action SHALL remain disabled until a real successful probe has populated the picker and a model is selected, so the operator cannot persist a credential whose Base URL/key were never validated or whose default model is not a real capability of the provider. The save payload SHALL carry `{mode: 'compatible', baseUrl, apiKey, defaultModel}` to `PUT /settings/codex` (the existing, correct transport). The dialog copy SHALL state that the provider must be **OpenAI Responses-API compatible** (codex 0.131 speaks only the Responses API), so operators do not configure a chat-completions-only endpoint that lists models successfully but fails at task run time.

#### Scenario: Test calls the real discovery endpoint
- **WHEN** the operator runs the connection test with a Base URL and API key
- **THEN** the dialog issues a real `POST /settings/codex/models` request and reflects its outcome (connected with a model list, or a descriptive auth/unreachable failure) rather than a client-side non-empty check

#### Scenario: Picker is populated from real discovered models and selection is required
- **WHEN** a discovery probe succeeds
- **THEN** the default-model picker is populated from the returned model identifiers and the operator must select one before save is enabled

#### Scenario: Save is gated on a real successful probe
- **WHEN** no real successful discovery has occurred (or no model is selected)
- **THEN** the save action is disabled, so an unvalidated compatible credential cannot be persisted from the dialog

#### Scenario: Dialog states the Responses-API requirement
- **WHEN** the operator opens the compatible-provider dialog
- **THEN** the copy states the provider must be OpenAI Responses-API compatible (not chat-completions-only), so a models-listing-only endpoint is not mistaken for a working provider
