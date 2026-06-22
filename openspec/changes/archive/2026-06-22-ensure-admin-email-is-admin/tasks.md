<!-- Single track: one file + its test, one concern (role promotion on the seed). -->

## 1. Track: admin-role-promotion (depends: none)

- [x] 1.1 `apps/api/src/admin-seed/admin-seed.service.ts` — add `role` to the `existing` user `select`, and in the already-exists path idempotently promote: if `existing.role !== 'admin'`, `prisma.user.update({ where: { id }, data: { role: 'admin' } })`. Run it early in the existing-account branch (before/independent of the password-lifecycle branches), touching ONLY `role` — do not change password, `allowed`, or `mustChangePassword`. No-op when already `admin`. Update the `SeedUserRow` shape to carry `role`.
- [x] 1.2 `apps/api/src/admin-seed/admin-seed.service.spec.ts` — add: (a) an existing `ADMIN_EMAIL` account with `role: 'member'` is promoted to `admin` on boot while its password identity / `allowed` / `mustChangePassword` stay unchanged; (b) an existing `role: 'admin'` account triggers no role write (idempotent). Keep the existing fresh-deploy / no-duplicate / reveal tests green (the fake `user.findUnique` now returns `role`; the fake `user.update` already records updates).
