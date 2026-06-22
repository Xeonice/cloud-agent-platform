## MODIFIED Requirements

### Requirement: API key resolution re-confirms the allowlist on every request

An API key presented as a credential SHALL be resolved by hashing the presented value and looking up the stored hash. Resolution SHALL fail closed (deny) when the key is unknown, revoked, or expired, OR when the owning user is no longer `allowed`. The owner's `allowed` flag SHALL be re-confirmed on EVERY request (not cached), so a disabled owner's keys stop working on their very next call. A successful resolution SHALL yield the owner as the principal's user and the key's granted scopes.

#### Scenario: Valid key resolves to its owner with scopes

- **WHEN** a request presents a non-expired, non-revoked `cap_sk_` key whose owner is `allowed`
- **THEN** the request is admitted as an `api-key` principal whose user is the key owner and whose scopes are the key's granted scopes

#### Scenario: Revoked or expired key is denied

- **WHEN** a request presents a key that has been revoked or whose expiry has passed
- **THEN** resolution returns no principal and the request is rejected with 401, with no state change

#### Scenario: Disabled owner's key stops working immediately

- **WHEN** the owner of a previously-valid key has `allowed` set to false
- **THEN** the next request presenting that key is denied, because the owner's `allowed` flag is re-confirmed at resolution time
