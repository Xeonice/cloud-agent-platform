## ADDED Requirements

### Requirement: Compatible-provider Codex credential injected into the codex run
When a task's owning account has an active `compatible`-mode Codex credential, the orchestrator SHALL inject that provider into the per-task codex run at provision time so codex calls the operator's Base URL with the operator's API key and selected default model. The compatible credential's API key SHALL be decrypted from its at-rest ciphertext and the resulting provider configuration SHALL be written into the sandbox `~/.codex/config.toml` using the SAME base64-decode file-injection idiom already used for `config.toml` (never inlined into the launch argv). Per the codex 0.131 config reference, the emitted config SHALL contain a `[model_providers.<id>]` block with `base_url` = the saved Base URL and `wire_api = "responses"` (the only supported value), plus top-level `model_provider = "<id>"` and `model = "<defaultModel>"`; the decrypted API key SHALL be delivered to that provider via `experimental_bearer_token` in the same block (or, equivalently, via an `env_key`-named environment variable set in the codex process). The orchestrator SHALL NOT write `~/.codex/auth.json` for compatible mode — `auth.json`'s `OPENAI_API_KEY` serves only the built-in `openai` provider, not a custom provider. The existing workspace `trust_level` block SHALL be preserved. The injected credential SHALL be resolved from the **task owner's** account, NOT the earliest allowlisted account — the auth source SHALL be scoped by the task's owning account identity so one operator's compatible key is never used for another operator's tasks. When the owning account has NO compatible credential, resolution SHALL fall back to the existing official/deployment-level source unchanged, so official-mode and env-configured deployments are unaffected. The Base URL SHALL pass the same host-safety validation applied at discovery time before it is written into the sandbox. Because the launch argv has no per-task substitution seam, ALL compatible provider state SHALL be carried via the provision-time config files, not the codex launch flags.

#### Scenario: Compatible credential drives codex's provider, key, and model
- **WHEN** a task is provisioned for an account whose active Codex credential is `compatible` with a saved Base URL, API key, and default model
- **THEN** the sandbox receives a `~/.codex/config.toml` with a `[model_providers.*]` block whose `base_url` is the saved Base URL and `wire_api = "responses"`, the decrypted key delivered via `experimental_bearer_token` (or an `env_key` env var), and top-level `model_provider` + `model = "<defaultModel>"`, and NO `~/.codex/auth.json` is written for the compatible credential
- **AND** codex issues its model requests against the operator's Base URL and selected model, not the default OpenAI endpoint or codex's built-in default model

#### Scenario: Injected credential is scoped to the task owner
- **WHEN** two allowlisted operators each have a different compatible credential and operator B launches a task
- **THEN** the credential injected into operator B's task is operator B's, not the earliest-created allowlisted operator's

#### Scenario: Accounts without a compatible credential keep the official/env path
- **WHEN** a task is provisioned for an account that has no compatible credential (official mode, or none)
- **THEN** the orchestrator injects the existing official/deployment-level codex auth unchanged and does NOT write a compatible `[model_providers.*]` block

#### Scenario: Unsafe provider Base URL is not written into the sandbox
- **WHEN** a compatible credential's Base URL resolves to a loopback/private/link-local/metadata host or a non-http(s) scheme
- **THEN** the orchestrator does not write that Base URL into the codex config (the credential is treated as unusable for injection rather than fetched/targeted)
