# Research brief — close-request-boundary-gaps

Baseline: `origin/main` @ `0216ab1` (v0.46.1), verified again on the working branch. Every claim below was re-confirmed by reading the code directly, not carried over from the review that first surfaced them.

The four findings share one shape: **a boundary check that the surrounding code assumes exists, and does not.** Three of them are checks on an incoming request's trust (who is it, where did it come from); the fourth is a check on what a page is allowed to load.

## 1. A machine credential reaches admin-only account operations

Two different admin judgements exist, with different semantics.

`apps/api/src/auth/admin.ts:21-29` is the strict one, and its doc comment states the rule plainly — *"a machine or legacy principal is never an admin"*:

```ts
if (!principal || principal.kind !== 'session' || principal.user === null) return false;
return principal.user.allowed === true && principal.user.role === 'admin';
```

`apps/api/src/accounts/accounts.controller.ts:132-153` is the permissive one. It re-reads the account row and checks `allowed`/`role`, but **never looks at `principal.kind`**:

```ts
const principal = req.operatorPrincipal;
const user = principal?.user;
if (!principal || !user) throw this.adminDenied();
const where = resolveAccountWhere(user);          // internal id, or githubId fallback
const account = await this.prisma.user.findUnique({ where, select: { role: true, allowed: true } });
if (!account || account.allowed !== true || account.role !== 'admin') throw this.adminDenied();
```

Its own comment acknowledges machine principals arrive here — *"fall back to the immutable numeric githubId for a github/**api-key** principal"*. The same pattern is in `apps/api/src/mail/smtp.controller.ts:205-` and `apps/api/src/sandbox-environments/sandbox-environments.controller.ts`.

Machine principals carry the full owning account, so the check passes for them:

- `apps/api/src/auth/operator-principal.ts:192-197` — `{ kind: 'api-key', user: resolved.user, scopes, keyId }`
- `apps/api/src/auth/auth.guard.ts:192-197` — `{ kind: 'mcp', user: authInfo.owner, scopes }`

**Scopes do not save it.** `operator-principal.ts:71-76` documents that scopes bound machine credentials, but nothing in these controllers consults them, and the scope vocabulary has no admin category to consult. A `cap_sk_` key minted by an admin with `scopes: ['tasks:read']` therefore satisfies `requireAdmin` and can call `PATCH /accounts/:id/password`.

The invariant is stated by the codebase itself, one file away from the break. `auth.guard.ts:185-187`:

> makes an `mcp_` token a recognised principal on owner-scoped REST routes **while kind-gated session-only routes still reject it**

The three controllers are the routes that were supposed to be kind-gated and are not.

Corroborating evidence that this is an oversight rather than a decision: the two endpoints that *mint* machine credentials explicitly refuse machine callers (`api-keys.controller.ts:101`, `mcp-tokens.controller.ts:112`). The guard against credential self-propagation was written; the guard against account administration was not.

**Blast radius**: password change, enable/disable, and role assignment on any account, plus SMTP and sandbox-environment administration — from a credential whose stated grant is read-only, and which is designed to be handed to external tooling.

## 2. No CSRF defence in the cross-origin deployment shape

`apps/api/src/auth/session-cookie.ts:42,52`:

```ts
sameSite: crossOrigin ? 'None' : 'Lax',
```

`crossOrigin` is the production topology — console on Vercel, API on its own domain. `SameSite=None` means the session cookie rides on cross-site requests, which is exactly what `SameSite` otherwise prevents.

Nothing replaces it. Repository-wide, `csrf`/`xsrf`/`sec-fetch-site` appear in **one** place: a comment at `apps/api/src/main.ts:189`. There is no CSRF token, no `Origin` check, no `Sec-Fetch-Site` check.

CORS does not close this. It governs whether a response may be *read*, not whether a request is *sent*: a cross-site form post or a `fetch(..., {mode:'no-cors'})` still reaches the handler with cookies attached, and side effects still happen. State-changing endpoints that need no readable response are the exposure — `POST /tasks/:id/stop`, `POST /accounts`, `POST /self-update`.

## 3. The WebSocket handshake does not check `Origin`

`apps/api/src/main.ts:132`:

```ts
app.useWebSocketAdapter(new WsAdapter(app));
```

No `verifyClient`, no `allowRequest` — repository-wide grep returns nothing. The gateway authenticates from the handshake cookie (`apps/api/src/terminal/terminal.gateway.ts:1054`).

Browsers do not apply the same-origin policy to WebSocket connections, and the CORS allowlist configured in `main.ts` covers HTTP only. Combined with `SameSite=None` from §2, any page can open a WebSocket to the terminal gateway with the operator's cookie attached and drive a PTY.

## 4. An unauthenticated page loads an unpinned, unverified third-party script

`apps/api/src/openapi/openapi.registry.ts:436,440`:

```html
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css" />
<script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js" crossorigin></script>
```

No version pin, no `integrity` attribute. (`crossorigin` is a CORS mode, not Subresource Integrity — it is a *precondition* for SRI, not a substitute.) `/v1/docs` is in the unauthenticated allowlist (`apps/api/src/auth/auth.guard.ts:87-92`), so this is an anonymously reachable page on the API's own origin that executes whatever `unpkg` serves today. Compromise of that package, or of the CDN, yields script execution on the API origin with the operator's cookies in scope.

## Verification approach

The program's rule for this change is reproduction test first. Three of the four are testable at the unit/integration level without a browser:

- §1 — construct an `api-key` principal whose owner is an admin, call the controller's admin path, assert rejection. Fails today.
- §2 — issue a state-changing request carrying a session cookie and a foreign `Origin`, assert rejection. Fails today.
- §4 — assert the rendered docs HTML pins a version and carries `integrity`. Fails today.

§3 needs a real WebSocket handshake against a booted gateway with a foreign `Origin`. `scripts/boot-smoke.sh` already boots the built app against a throwaway Postgres, which is the natural place for it.

## Scope boundaries

In scope: the four gaps above, each with a reproduction test that fails before the fix.

Out of scope, recorded so the boundary is deliberate rather than accidental:

- **Diagnostics read-scope widening.** `task-provisioning-diagnostics-console-query.service.ts:88-98` admits any enabled account (admin *or* member) and uses `role === 'admin'` only to widen the read from owned tasks to all tasks. Checked during implementation and deliberately left alone: it is not an admin-only gate, so the kind rule does not apply unchanged. Whether an admin's API key should see all diagnostics or only its owner's is a read-visibility question, which is the owner-scoping decision below.
- **Owner-scoping of tasks/transcripts/repos.** `tasks.service.ts:1609` lists without a `where`; `v1-transcript.controller.ts:55` verifies scope but not ownership — while schedules and forge credentials *are* owner-scoped. That is a product decision (shared instance vs. private) before it is a fix, and it needs its own change.
- **Audit coverage of security events.** Login, password change, role change, credential mint/revoke and self-update record nothing. The table and endpoints exist; only the call sites are missing. Adjacent, but a different piece of work.
- **A global `ValidationPipe`.** Two controllers eat unvalidated bodies (`provider-terminal-story.controller.ts:34`, `self-update.controller.ts:74`) while fourteen others opt in by hand. Mechanism change, not a boundary gap.
- **Encryption envelope versioning / key rotation**, and the second and third copies of the envelope codec. Belongs with the cross-cutting mechanism extraction later in the program.
