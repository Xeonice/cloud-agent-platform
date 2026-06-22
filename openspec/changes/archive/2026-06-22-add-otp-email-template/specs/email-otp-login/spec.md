## ADDED Requirements

### Requirement: Verification-code email is a branded HTML template

The verification-code email SHALL be sent as a branded HTML template with a plaintext fallback in
the same message (`multipart/alternative`), rather than a bare plaintext line. The HTML SHALL be
email-safe (table layout + inline CSS so clients that strip `<style>` or lack modern CSS still
render it) and SHALL follow the console's Vercel/Geist design: achromatic palette (no decorative
accent color), the AC brand mark, and the verification code shown prominently in a monospace
treatment. Both the HTML and the plaintext part SHALL contain the verification code and its
validity window, and the subject SHALL be localized. The code interpolated into the template SHALL
be only the generated numeric code (no free-text input enters the template). This changes only the
email's PRESENTATION — generation, TTL, attempt cap, resend cooldown, hash-at-rest storage, and the
uniform non-disclosing response are unchanged.

#### Scenario: The OTP email carries both an HTML part and a plaintext fallback

- **WHEN** a verification code is emailed to an allowed account
- **THEN** the message includes an HTML body AND a plaintext body, and both contain the verification code and its validity window

#### Scenario: The plaintext fallback keeps the code readable without HTML

- **WHEN** the email is opened in a client that does not render HTML
- **THEN** the plaintext part still presents the verification code and its expiry

#### Scenario: Presentation change does not alter OTP security behavior

- **WHEN** the templated email is sent
- **THEN** the code is still a single-use CSPRNG numeric value stored only as a hash with the same TTL, attempt cap, and resend cooldown, and the request response stays uniform and non-disclosing
