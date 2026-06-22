# Verification Report — ensure-admin-email-is-admin

## Verdict

PASS. The raw-unmet set was empty (`[]`). Every requirement in the modified
`default-admin-bootstrap` spec re-traces end-to-end against the actual code and the
11 passing unit tests in `apps/api/src/admin-seed/admin-seed.service.spec.ts`.

- Reopened code tasks this pass: 0
- Spec defects routed to design.md Open Questions: 0
- Requirements adjudicated MET (re-traced, not rubber-stamped): all 4 scenarios

## Met requirements (re-traced end-to-end)

The single modified requirement — *Idempotent default-admin seed on boot* — and all
four of its scenarios are satisfied:

- **Scenario: Fresh deploy gets a usable admin** —
  `seedAdmin()` `!existing` branch → `createAdmin()` writes `role='admin'`,
  `allowed=true`, `mustChangePassword=true`
  (`apps/api/src/admin-seed/admin-seed.service.ts:181-192`, `:264-283`). Proven by the
  test at `admin-seed.service.spec.ts:241`.
- **Scenario: Re-boot does not duplicate or reset the admin** —
  the already-exists branch never `create`s and the reveal-consumed / fixed-password
  guards return without resetting a customized admin
  (`admin-seed.service.ts:207-221`). Proven by `admin-seed.service.spec.ts:348`.
- **Scenario: An existing non-admin ADMIN_EMAIL account is promoted to admin (role only)** —
  `if (existing.role !== 'admin')` issues `prisma.user.update({ data: { role: 'admin' } })`
  touching ONLY `role`, ahead of and independent from the password-lifecycle branches
  (`admin-seed.service.ts:199-205`; `role` added to the `findUnique` select at `:178` and
  to `SeedUserRow` at `:102-106`). Proven by `admin-seed.service.spec.ts:273`, which
  asserts `allowed`, `mustChangePassword`, and the password-identity secret are all
  unchanged while `role` flips to `admin`.
- **Scenario: Promotion is idempotent for an already-admin account** —
  the `existing.role !== 'admin'` guard prevents any `user.update` when the account is
  already `admin`. Proven by `admin-seed.service.spec.ts:314`, which spies on
  `user.update` and asserts zero calls.

The downstream UX justification also holds: `useIsAdmin` requires `role === "admin"`
(`apps/web/src/hooks/use-account-menu.ts:119`), so the role correction is what unblocks
the account-administration entry for the owner.

## Gap analysis

All four scenarios from the spec are fully covered by the implementation. Every requirement in the `default-admin-bootstrap` spec has traceable implementation:

- **Idempotent seed on boot**: `onApplicationBootstrap` → `seedAdmin()` with `findUnique` before any write
- **ADMIN_EMAIL key**: `adminEmail()` env read
- **role=admin, allowed=true, mustChangePassword=true on creation**: `createAdmin()`
- **Self-contained (no ordering deps)**: single `OnApplicationBootstrap` in one service
- **ADMIN_PASSWORD sets hash, DB stores only argon2 hash**: `fixedAdminPassword()` + `hasher.hash()`
- **Promotes existing non-admin to admin (role only)**: `if (existing.role !== 'admin')` guard with `data: { role: 'admin' }` only
- **No change if already admin**: guard prevents update call

## Scope analysis

Now I have a complete picture. The spec for this change (`ensure-admin-email-is-admin`) contains exactly four scenarios scoped to role promotion. The tasks scope to just two files (service + test). Here is the analysis:

**Behaviors in the implementation that map to NO requirement in the current change's spec:**

The spec only covers:
- Scenario: Fresh deploy creates admin (role=admin, allowed=true, mustChangePassword=true)
- Scenario: Re-boot does not duplicate or reset
- Scenario: Existing non-admin ADMIN_EMAIL promoted (role only)
- Scenario: Already-admin gets no role write (idempotent)

Everything else was inherited from the prior `add-private-account-identity` change and is not a requirement of this change's spec. However, the question asks about behaviors that map to NO requirement — I need to check against the current spec only.

Looking at the service file (`admin-seed.service.ts`): all the non-role-promotion code (reveal lifecycle, password generation, restart-regeneration, ADMIN_PASSWORD support, etc.) predates this change. The only new behavior added by this change is the role promotion in lines 199–205.

In the **test file**, the tasks.md says task 1.2 requires adding two specific new tests. Tests at lines 273 and 314 directly satisfy those. All other tests (lines 241, 348, 379, 401, 426, 445, 476, 489, 498) cover pre-existing behaviors not specified by the current change's spec.

Out-of-scope (pre-existing, inherited from `add-private-account-identity`):

- test: 'fresh deploy seeds an admin (role=admin, allowed, mustChangePassword) with a password identity' — covers fresh-create path from prior change, not a requirement of ensure-admin-email-is-admin spec — `apps/api/src/admin-seed/admin-seed.service.spec.ts:241`
- test: 're-boot after the reveal is consumed leaves the admin intact (no duplicate, no reset)' — covers reveal-consumed idempotency from prior change, not in current spec — `apps/api/src/admin-seed/admin-seed.service.spec.ts:348`
- test: 'the one-time reveal returns the credential once, then nothing' — exercises AdminRevealController one-time reveal from prior change, not a requirement of this spec — `apps/api/src/admin-seed/admin-seed.service.spec.ts:379`
- test: 'reveal yields nothing when nothing was generated (fixed ADMIN_PASSWORD)' — fixed ADMIN_PASSWORD path from prior change, not in current spec — `apps/api/src/admin-seed/admin-seed.service.spec.ts:401`
- test: 'only the argon2 hash is stored — the generated plaintext is never persisted' — no-plaintext invariant from prior change, not in current spec — `apps/api/src/admin-seed/admin-seed.service.spec.ts:426`
- test: 'restart before the reveal is consumed regenerates the password (DB held no plaintext)' — restart-regenerates behavior from prior change, not in current spec — `apps/api/src/admin-seed/admin-seed.service.spec.ts:445`
- test: 'generateStrongPassword yields distinct, sufficiently-long, unambiguous passwords' — helper tests from prior change, not in current spec — `apps/api/src/admin-seed/admin-seed.service.spec.ts:476`
- test: 'seed is a no-op when ADMIN_EMAIL is unset' — ADMIN_EMAIL-absent guard from prior change, not in current spec — `apps/api/src/admin-seed/admin-seed.service.spec.ts:489`
- test: 'boot hook never throws even if the seed write fails' — error-swallowing boot hook from prior change, not in current spec — `apps/api/src/admin-seed/admin-seed.service.spec.ts:498`
- service: ADMIN_PASSWORD / fixedAdminPassword() branch (lines 173-174, 208-211) — fixed-password lifecycle not mentioned in ensure-admin-email-is-admin spec — `apps/api/src/admin-seed/admin-seed.service.ts:173`
- service: revealConsumed() + regenerate-password-on-restart path (lines 213-229) — restart-regeneration lifecycle not in current spec — `apps/api/src/admin-seed/admin-seed.service.ts:213`
- service: AdminRevealHolder class (lines 78-95) — in-memory reveal holder from prior change, not in current spec — `apps/api/src/admin-seed/admin-seed.service.ts:78`
- service: generateStrongPassword() exported helper (lines 316-325) — password generation utility from prior change, not in current spec — `apps/api/src/admin-seed/admin-seed.service.ts:316`
- service: resetPasswordIdentity() private method (lines 292-308) — restart-regeneration mechanism from prior change, not in current spec — `apps/api/src/admin-seed/admin-seed.service.ts:292`

These out-of-scope items are correctly inherited behavior; none introduces a spec defect for this change.
