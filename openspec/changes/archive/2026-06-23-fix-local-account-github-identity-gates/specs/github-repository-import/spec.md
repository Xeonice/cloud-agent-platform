## ADDED Requirements

### Requirement: A local account with a connected GitHub identity can import repos

GitHub repo listing/import SHALL resolve the requesting account's OWN stored GitHub token by the
account primary key (`user.id`), so a local (password/OTP) account that has SEPARATELY connected a
GitHub `IdentityLink` can list and import. The boundary gate SHALL require an authenticated account
(an identity-less principal is rejected); an account with no usable GitHub token SHALL receive the
distinct `github_auth_required` signal — NOT a session 401, NOT a silent empty list.

#### Scenario: Local account with a connected GitHub identity imports

- **WHEN** a local account that has connected a GitHub `IdentityLink` lists or imports GitHub repos
- **THEN** its own stored token is resolved by account id and the operation proceeds

#### Scenario: No usable GitHub token yields github_auth_required

- **WHEN** an authenticated account has no usable GitHub token
- **THEN** it receives `github_auth_required` (not a session 401, not a silent empty list)

#### Scenario: Identity-less principal is rejected at the boundary

- **WHEN** a machine/legacy principal with no account calls the import surface
- **THEN** it is rejected before any token read
