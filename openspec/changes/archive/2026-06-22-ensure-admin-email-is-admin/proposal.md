## Why

The default-admin seed only sets `role = admin` on the CREATE path (`!existing`). When the
`ADMIN_EMAIL` account already exists — e.g. it was first created via GitHub OAuth, which defaults
new accounts to `role = member` — the seed takes the "already exists" branch and never touches the
role. Result: the deployment owner (whose email is `ADMIN_EMAIL`) is stuck as `member`, the
account-administration entry is UX-gated off (`useIsAdmin` requires `role === "admin"`), and the
`/accounts` page server-redirects them away. Observed live: `ADMIN_EMAIL`'s account had
`role = member`. The spec already says the seed SHALL "ensure a default administrator account
exists, identified by `ADMIN_EMAIL`, with `role = admin`" — so an existing non-admin `ADMIN_EMAIL`
account violates it.

## What Changes

- **admin-seed promotes an existing `ADMIN_EMAIL` account to admin.** In the already-exists branch,
  if the account's `role !== "admin"`, the seed idempotently updates it to `admin`. This corrects
  the `ADMIN_EMAIL` semantics from "is admin only when the seed creates it" to "is ALWAYS the admin
  role, however the account was created".
- **Minimal blast radius.** The promotion touches ONLY `role`. It does NOT reset the password, the
  `allowed` flag, or `mustChangePassword` — the seed's "never reset an already-customized admin"
  discipline is preserved; this is a role correction, not a credential reset.
- **Idempotent.** When the account is already `admin`, the seed makes no change.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `default-admin-bootstrap`: the boot seed ensures the `ADMIN_EMAIL` account is `role = admin` even
  when it already exists (idempotent promotion), not only when the seed creates it.

## Impact

- **Backend:** `apps/api/src/admin-seed/admin-seed.service.ts` — the existing-account branch gains
  an idempotent role promotion; the `existing` lookup additionally selects `role`.
- **Tests:** `apps/api/src/admin-seed/admin-seed.service.spec.ts` — add coverage for promotion + the
  already-admin no-op.
- **No schema/contract change.** Deploying + a boot promotes the live `ADMIN_EMAIL` member account
  to admin, after which the account-administration UI appears for the owner.
- No change to the password / one-time-reveal lifecycle, the `allowed` flag, or other accounts.
