## Context

`AdminSeedService.seedAdmin` (apps/api/src/admin-seed/admin-seed.service.ts) sets `role = admin`
only inside `createAdmin`, which runs only on the `!existing` path. The already-exists branch
manages the password/reveal lifecycle but never reads or changes `role`. So an `ADMIN_EMAIL`
account created some other way — notably GitHub OAuth, which mints `role = member` — stays
`member` forever. `useIsAdmin` (frontend) requires `role === "admin"`, and the `/accounts` gate
redirects non-admins, so the owner can't reach account administration. Verified live: the
`ADMIN_EMAIL` account was `member`.

## Goals / Non-Goals

**Goals:**
- The `ADMIN_EMAIL` account ends every boot as `role = admin`, whether the seed created it or it
  pre-existed (e.g. via GitHub OAuth).
- Idempotent: an already-admin account triggers no write.

**Non-Goals:**
- No password reset, no `allowed` change, no `mustChangePassword` change on the promotion path —
  this is a role correction, not a credential reset.
- No effect on any account other than the one keyed by `ADMIN_EMAIL`.
- No change to the create path, the one-time-reveal lifecycle, or schema.

## Decisions

**D1 — Promote in the already-exists branch, touching only `role`.** When `existing` is found and
its `role !== "admin"`, update only `role` to `admin`. The password, `allowed`, and
`mustChangePassword` are deliberately left untouched, preserving the seed's load-bearing "never
reset an already-customized admin" discipline. This makes `ADMIN_EMAIL` mean "always the admin
role", not "admin only if the seed created it".

**D2 — Promotion is orthogonal to the password lifecycle.** Role is independent of the
generated/fixed/consumed password branches, so the promotion runs early in the existing-account
path and applies regardless of which password branch follows. The `existing` lookup adds `role` to
its `select`.

**D3 — Idempotent + trusted input.** If `role` is already `admin`, no update is issued.
`ADMIN_EMAIL` is operator-supplied deploy configuration (trusted); promoting exactly that one
account to admin is the intended semantics and cannot affect other users.

## Risks / Trade-offs

- **An operator who deliberately demotes the `ADMIN_EMAIL` account to `member` will see it
  re-promoted on the next boot.** → That is the defined semantics of `ADMIN_EMAIL` (it names the
  admin); to remove admin, repoint or unset `ADMIN_EMAIL` rather than demoting the row. Documented
  via the spec scenario.
- **Promotion without re-enabling `allowed`.** → Intentional: a disabled `ADMIN_EMAIL` account is
  not silently re-enabled; only the role is corrected. (In practice `ADMIN_EMAIL` accounts are
  enabled; this just avoids a surprising side effect.)

## Migration Plan

- Pure code change, no schema/contract change. Deploy the api image; on boot the seed promotes the
  live `ADMIN_EMAIL` member account to admin. The owner then sees the account-administration entry
  after a refresh / next session resolve.
- Rollback: revert the service change; the live row stays admin (a forward-only data effect, which
  is the desired end state anyway).

## Open Questions

- None.
