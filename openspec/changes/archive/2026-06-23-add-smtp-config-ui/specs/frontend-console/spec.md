## ADDED Requirements

### Requirement: Settings page has an admin-only Resend SMTP section

The Settings page SHALL present an admin-only 邮件发送（Resend）section where an administrator can
view the current configuration status (masked — the API Key shown only as a suffix, NEVER plaintext),
open a Resend-shaped config dialog, and send a test email. The dialog SHALL collect only what Resend
needs — the **API Key** (which IS the SMTP password) and the **sender (from) address** — and SHALL
present the fixed parameters (`smtp.resend.com` / port `465` / username `resend`) as fixed copy,
NOT editable fields. The API Key field SHALL NEVER be pre-filled (empty = keep the existing key);
the sender field SHALL carry a hint that the domain must be verified at Resend while the local part
is free (no real mailbox needed). The section and dialog SHALL link to the Resend help page.
Non-admin operators SHALL NOT be shown the management controls — a UX gate only; the backend
independently enforces admin-only on every SMTP endpoint.

#### Scenario: Admin configures Resend with only API Key + sender

- **WHEN** an admin opens the Resend SMTP config dialog
- **THEN** it asks only for the API Key and the sender address (the host/port/username are shown as fixed Resend values, not inputs) and offers a 发送测试 action

#### Scenario: The API Key is never pre-filled

- **WHEN** the dialog opens for an existing configuration
- **THEN** the API Key field is empty (the server returned only a masked suffix) while the sender address may be pre-filled

#### Scenario: Non-admin does not see the controls

- **WHEN** a non-admin operator opens Settings
- **THEN** the Resend SMTP management controls are not presented (and the backend denies any SMTP endpoint regardless)

### Requirement: Resend SMTP help page

The console SHALL provide a Resend SMTP help page behind the auth gate, reachable from the SMTP
section and dialog, rendering app-authored markdown through the SAME trusted pipeline as the
forge-token help (react-markdown + remark-gfm, no raw HTML execution; content loaded at build time).
It SHALL document, in order: verifying a sending domain, creating an API Key, filling the console
(API Key + sender), the fixed parameters, and the mainland-email caveat.

#### Scenario: Help page is reachable from the SMTP section

- **WHEN** an admin clicks the help link in the SMTP section or the config dialog
- **THEN** the Resend SMTP help page opens behind the auth gate with the step-by-step setup

#### Scenario: Help renders trusted app-authored markdown

- **WHEN** the help page renders
- **THEN** it shows the app-authored markdown via the trusted renderer (GFM, no raw HTML execution)
