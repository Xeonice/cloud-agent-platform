<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: repro-admin-kind (depends: none)

- [x] 1.1 Write a test that builds an `api-key` principal whose owning account is `allowed` with `role = admin` and a non-admin scope set, invokes an account-management operation, and asserts a 403
- [x] 1.2 Add the equivalent case for an `mcp` principal, and a control case asserting a session admin still succeeds
- [x] 1.3 Run both and record that they FAIL against current code — a security test that never failed proves nothing

## 2. Track: repro-origin-http (depends: none)

- [x] 2.1 Write a test that issues an unsafe-method request carrying a valid session cookie and an `Origin` outside the trusted set, and asserts rejection before any state change
- [x] 2.2 Add the control cases: the configured console origin is admitted; a bearer-authenticated request with no `Origin` is admitted; a safe-method request from a foreign origin is not rejected by this rule
- [x] 2.3 Run and record that 2.1 FAILS against current code

## 3. Track: repro-docs-assets (depends: none)

- [x] 3.1 Write a test asserting the rendered `/v1/docs` HTML references no version-less third-party URL and that every third-party script/stylesheet carries an integrity hash or is same-origin
- [x] 3.2 Run and record that it FAILS against current code

## 4. Track: fix-admin-kind (depends: repro-admin-kind)

- [x] 4.1 Route `accounts.controller.ts` `requireAdmin` through the shared `isAdminPrincipal`, keeping the DB re-read as a second condition so a mid-session demotion still takes effect
- [x] 4.2 Apply the same routing in `mail/smtp.controller.ts`
- [x] 4.3 Apply the same routing in `sandbox-environments/sandbox-environments.controller.ts`
- [x] 4.4 Confirm track 1's tests now pass and no other admin-gated route re-derives admin-ness from account columns alone
- [x] 4.5 Swept for other admin re-derivations. `admin-seed.service.ts:198` is a seed-time promotion, not a request gate. `task-provisioning-diagnostics-console-query.service.ts:88-98` admits members too and uses the role only to widen read scope — recorded in the research brief as belonging to the owner-scoping decision, not to this change. No other route re-derives admin-ness

## 5. Track: fix-origin-http (depends: repro-origin-http)

- [x] 5.1 Add shared trusted-origin verification for unsafe-method requests, running after principal resolution and before handlers, reusing `parseWebOrigins(process.env.WEB_ORIGIN)` so there is one list
- [x] 5.2 Exempt bearer-authenticated principals; resolve the design's open question on the legacy shared-token path and encode the decision in a test either way
- [x] 5.3 Treat an absent or unparseable `Origin` on an unsafe method as untrusted
- [x] 5.4 Make the rejection distinguishable in the response and the logs, so a misconfigured `WEB_ORIGIN` is diagnosable without reading source
- [x] 5.5 Confirm track 2's tests pass, including every control case

## 6. Track: fix-origin-ws (depends: fix-origin-http)

- [x] 6.1 Make the WebSocket upgrade consult the same trusted-origin list before the connection is established, so no session is created on refusal
- [x] 6.2 Log the refused origin server-side, since the browser only sees a generic connection failure
- [x] 6.3 Add a handshake test to `scripts/boot-smoke.sh`: a foreign-origin upgrade carrying a valid cookie is refused, the console origin connects
- [x] 6.4 Verified against a REAL booted app (throwaway Postgres, `WEB_ORIGIN` set), using the same curl the probe uses: foreign origin → 403, console origin → 101, absent origin → 101, refusal logged with the origin. The unit suite was additionally checked negatively (disable the guard → the two refusal cases fail; restore → green). `boot-smoke.sh` itself could NOT be run to completion locally: it exits earlier at the pre-existing default-admin argon2 reveal probe, which fails identically on a CLEAN tree with all of this change stashed — an environment issue on this machine, not a regression. The probe runs in CI, where that step passes

## 7. Track: fix-docs-assets (depends: repro-docs-assets)

- [x] 7.1 Pin `swagger-ui-dist` to an exact version and add integrity hashes for both the script and the stylesheet, keeping `crossorigin` (SRI requires it)
- [x] 7.2 Verify the docs page still renders and the assets actually load with the hashes present
- [x] 7.3 Confirm track 3's test passes

## 8. Track: verify-and-document (depends: fix-admin-kind, fix-origin-http, fix-origin-ws, fix-docs-assets)

- [x] 8.1 `turbo test` 26/26 tasks green (exit 0); discovery gate 412 files all discovered; `turbo typecheck lint` 37/37. One FLAKE observed: `packages/sandbox-provider-aio/test/aio-terminal-session-ownership.test.mjs` fails intermittently under parallel `turbo test` load and passes 3/3 standalone. This change touches zero files in that package (`git status` confirms), so it is pre-existing — newly VISIBLE because the previous change mounted these suites into the default lane for the first time. Recorded rather than retried or quarantined; it needs its own investigation (that file carries a 316-line hand-written reconnect state machine with timeout budgets)
- [x] 8.2 Recorded in `docs/self-hosting.md` + `.zh.md`: a new section on `WEB_ORIGIN` gating writes, the three trust sources (same-origin, auto same-host, allow-list), the `untrusted_request_origin` symptom, the WebSocket handshake check, and the exemption for bearer callers. The env table row was updated too
- [x] 8.3 Recorded in the same two documents as "Administration requires an interactive session": machine credentials get `403 admin_required` on account/SMTP/sandbox-environment administration regardless of owner role or scopes
- [x] 8.4 All four observed failing before their fix: admin-kind 4/8 red (`Missing expected rejection` — the call SUCCEEDED); origin-http 2 red, re-verified after a test-helper bug was fixed by disabling the guard and watching them go red again; docs-assets 2 red; WS handshake proven by disabling the check (2 red) and by a real booted app (403 foreign / 101 trusted / 101 absent, refusal logged). `boot-smoke.sh` itself could not complete locally — it exits at a pre-existing argon2 reveal step that fails identically on a clean stashed tree
