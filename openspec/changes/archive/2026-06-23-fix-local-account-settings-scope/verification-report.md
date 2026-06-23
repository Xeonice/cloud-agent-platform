# Verification Report — fix-local-account-settings-scope

## Verdict

PASS. Every requirement across both ADDED specs (`account-settings`, `forge-credentials`)
re-traces end-to-end as satisfied. The raw-unmet list handed to this routing pass was empty
(`[]`); the end-to-end re-trace below confirms there is nothing to reopen as a code task and
no spec defect. Routing tally: 0 reopened, 0 spec-defects, 0 reclassified (nothing was raw-unmet).

## Method

Re-traced each spec scenario through the REAL services (not the skeptic's summary): the
`SessionUser` contract, all five SessionUser construction sites, the three scope gates, the
controller gate, and the dedicated `account-scope.spec.ts` exercising the gates end-to-end via an
in-memory Prisma fake keyed by `userId`. Built (`pnpm build` → `prisma generate` + `nest build`)
and ran the compiled specs.

### Test evidence

- `dist/settings/account-scope.spec.js` — 9/9 pass (the dedicated scope test).
- settings + auth + auth-password + auth-otp compiled specs — 119/119 pass, 0 fail.
- Build green (Prisma client generated, nest build clean), so the now-REQUIRED `SessionUser.id`
  type-checks at every construction site (TypeScript would have failed the build otherwise).

## Requirement-by-requirement (all MET)

### account-settings/spec.md — "Per-account settings are scoped by account id …"

1. **Scope is account id, not GitHub identity** — `settings.service.ts requireUserId` (≈747) returns
   `operator.id` directly; the `githubId` number-check and `findUnique({where:{githubId}})` reverse
   lookup are deleted. MET.
2. **Local account reads/writes its own Codex credential (no `account_scope_required`)** — covered by
   `account-scope.spec.ts` "LOCAL account can read + write its Codex credential" (row scoped to
   `LOCAL.id`). MET.
3. **GitHub account unaffected (no regression)** — rows still keyed by `user.id`, which is unchanged
   for a GitHub account; "GitHub account still resolves its own Codex credential" passes. MET.
4. **Codex device login works for a local account** — `codex-device-login.service.ts` re-keyed to
   `Map<string, LoginSession>`; `requireKey` (≈243) uses `operator.id`. The device-login test shows a
   LOCAL account resolves a key (returns `error: no session`, not a thrown scope error). MET.
5. **Identity-less principal rejected** — defensive branch in `requireUserId`/`requireKey` and the
   controller's `requireOperator` (≈313, rejects null `user`); two tests assert
   `account_scope_required` for the identity-less principal. MET.
6. **Per-account isolation preserved** — scope is exactly one `userId`; "account A cannot read account
   B credential" passes. MET.

### forge-credentials/spec.md — "Forge credentials are scoped by account id …"

1. **Forge scope by account id, available to local accounts** — `forge-credential.service.ts
   requireUserId` (≈276) returns `operator.id`; same deletion of the githubId detour. MET.
2. **Local account connects/lists/removes without `account_scope_required`** — "LOCAL account can
   connect + list forge credentials" passes (row scoped to `LOCAL.id`). MET.
3. **Forge owner isolation** — `findMany({ where: { userId } })`; "forge list is scoped to the account
   id" passes (A sees none of B's). MET.

## Gap findings (informational, non-blocking)

No completely-absent requirement was found. Every scenario from both specs has traceable
implementation (service logic + controller gate) AND a passing test. There is no gap that blocks any
primary scenario; nothing routed to design.md Open Questions.

## Scope / scope-creep findings (NOT part of this change)

The working tree carries a SECOND, unrelated OpenSpec change (`improve-otp-login-ux`) whose edits are
interleaved here. The following belong to `improve-otp-login-ux`, NOT to
`fix-local-account-settings-scope` (whose stated impact is backend-only:
`@cap/contracts` + `apps/api`), and must NOT be attributed to this change at verify/archive time:

- `apps/web/src/routes/login.tsx:443-531` — OTP resend countdown (60s timer, `startCountdown`,
  remaining state, `clearTick`) added to `OtpPanel`.
- `apps/web/src/routes/login.tsx:127-150` — post-send non-disclosing notice UI block (`.otp-sent-note`
  paragraph, `OTP_SENT_NOTICE` constant).
- `apps/web/src/routes/login.tsx:155-175` — exported pure helpers `otpSendButtonLabel()` and
  `isOtpSendDisabled()`.
- `apps/web/src/routes/login.otp-resend.test.tsx:1` — new 146-line test of OTP resend UX (no
  requirement in this change's specs).
- `apps/web/e2e/design-baseline/login.html:70-91` — design-baseline updated with `.otp-sent-note`
  styles + countdown button HTML.
- `apps/web/e2e/visual/manifest.ts:98-107` — visual manifest comment documenting the
  `improve-otp-login-ux` re-sync.

In-scope for THIS change (do not mistake for creep): `packages/contracts/src/session.ts`
(adds required `id`), the SessionUser construction sites
(`auth-session.service.ts`, `auth-password/password.service.ts`, `auth-otp/email-otp.service.ts`),
the four `settings/*` service+controller edits, `settings/account-scope.spec.ts` (new), and the
one-line SessionUser-fixture additions across the affected `*.spec.ts` files (task 2.4 fixture
upkeep for the now-required `id`).
