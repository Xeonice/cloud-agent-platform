## Context

Measured on `83bb319`, with the Vercel facts read from the live project rather
than inferred:

```
vercel ls cap-web            production deployment 14h old
vercel inspect <that url>    aliases include cap-console.douglasdong.com
                             AND cap-web-git-main-…  ← Vercel assigns this form
                                                       only when production
                                                       tracks a branch
git tag --sort=-creatordate  v0.46.1
git rev-list --count v0.46.1..HEAD                    19
git log v0.46.1..HEAD -- apps/web packages/contracts  ≥10 commits
```

The release side is already coordinated and needs no repair:

```
release.yml  one tag → one commit → cap-api · cap-web · cap-aio-sandbox · cap-boxlite-sandbox
             :222 passes VITE_BUILD_ID=${version} to the image build
compose      web profile pins image: cap-web:${CAP_VERSION}, same var as the api
```

Constraints:

- **No workflow in `.github/` touches Vercel.** The production deploy is driven by
  Vercel's own git integration, so turning it off is a repository-side declaration
  (`vercel.json`) or a dashboard setting, not a workflow edit.
- **`buildId()` has zero callers** (`apps/web/src/lib/config.ts:249`), which is why
  the Vercel path returning `"dev"` has never been visible.
- **The console does not send `ConnectAuthFrame` at all.** It presents its
  credentials on the handshake URL (`ws-client.ts:133-141`: a `token` query
  parameter plus a `bearer.<token>` subprotocol) and the api reads them from the
  URL (`terminal.gateway.ts:1045`). This was recorded here as
  "`ConnectAuthFrameSchema` is non-strict, which decides the rollout order" —
  wrong, and see D5 for what replaced it.
- **`scripts/boot-smoke.sh` does not exercise this**; it probes the api alone.
- **The operator has decided** that the release drives the console deploy (option
  B of three), and that the currently-stale host is not urgent because the stack
  will be rebuilt after the refactor.

## Goals / Non-Goals

**Goals:**

- A production console can only come from a release.
- If the two sides ever differ anyway, something says so instead of serving.
- The identity plumbing works on BOTH deployment paths, and the difference between
  them stops being invisible.

**Non-Goals:**

- Deciding what "compatible" means. The invariant is sameness.
- Moving `cap-www`.
- Upgrading the running host.

## Decisions

### D1 — The release publishes the console; the git integration stops publishing production

Three ways to hold the invariant were considered and the operator picked the
second:

| | | |
|---|---|---|
| A | Vercel production branch → a tag pattern | one dashboard setting, but the deploy still fires on Vercel's schedule rather than the release's, leaving a window |
| **B** | `release.yml` runs `vercel deploy --prod` | **chosen** — makes the release the single deployment entry point, which is the literal form of "releases too" |
| C | Drop the hosted console; use the compose `web` profile | the invariant holds by construction, at the cost of the hosted console |

Preview deployments stay. A pull-request preview is not production and was never
part of the invariant; removing it would cost review value for no safety.

*Alternative rejected — leave the git integration on and only add the assertion.*
The assertion would then fire on every merge to `main` until the host caught up,
which trains an operator to ignore it. A gate that fires constantly is a gate that
gets turned off.

### D2 — The identity is the release version, not a content fingerprint

The earlier framing of this problem asked for a per-schema fingerprint compared as
an intersection at runtime, because the question was "are these two compatible".
Under the invariant the question is "are these two the same build", and that has
one answer with one value.

This also retires a trap: a content fingerprint changes when a schema neither side
uses changes, and does not change when a behaviour changes without its schema
changing. Version identity has neither property — it is exactly as precise as the
release, which is the thing being asserted.

*Consequence for the epic:* §4 Phase 2's "what is COMPATIBLE — five inputs from the
audit" is superseded, not implemented. Two of those five (`AdminRevealResponse`'s
missing absent-arm, the `z.array` vs `{ runtimes }` envelope) were defects and are
already fixed; the remaining three describe rules for a negotiation this change
removes the need for. What survives is worth keeping in the codebase for its own
sake — the closed-enum `.parse` on responses at `real.ts:1322`, and the ~11
vocabulary-erasing `as never` casts — but as code quality, not as gate inputs.

### D3 — The sentinel becomes a failure in a deployed build, and a spec changes to say so

`release-and-versioning` currently requires: "It SHALL default to a sentinel (e.g.
`"unknown"` / `"dev"`) when not provided at build time", with a scenario asserting
the console "reports a sentinel rather than failing".

That was correct when nothing read the value. It is the reason the Vercel path
could stay unplumbed for its whole life while looking identical to a laptop build.
Once the identity is load-bearing, a sentinel arriving from a deployed console is
not a graceful degradation — it is the absence of the thing being asserted.

So: local development keeps the sentinel and keeps working. A console that
presents a sentinel to the api is refused. The requirement is modified rather than
worked around, because a spec that still promises the old behaviour while the code
does the new one is the drift this programme keeps finding.

### D4 — "Independently deployable" is split into its two senses

`multi-target-deploy` says "Web and API are independently deployable via
env-configurable URLs". Read closely it is about ORIGINS — the web must reach the
api through `API_BASE_URL`/`WS_URL` and must not assume same-origin. Nothing in it
is about versions.

But the title says "independently deployable", and this change makes that false in
one of its two readings. Independently **addressable** stays true and unchanged;
independently **versioned** becomes false by design. The requirement is modified to
name both, so no future reader takes the title as licence to skew.

### D5 — Fail closed, and the rollout order is what makes that safe

A mismatch refuses the request. The operator's position is that incompatibility
should not exist — which makes a mismatch a deployment defect, and serving through
a defect is what produced the empty runtime list this change opens with.

The order matters, because fail-closed on a field the other side does not send yet
would break everything at once:

```
1. api learns to READ the identity and compare — absent ⇒ tolerated (today's console
   sends nothing)
2. console starts SENDING it, released together with that api
3. only then does absent ⇒ refused
```

Step 3 is a separate flip, and it is a task in this change rather than a follow-up,
because leaving it undone leaves the assertion decorative — the failure mode this
programme has now hit three times.

**Correction, found in implementation.** This design asserted that
`ConnectAuthFrameSchema` being a non-strict `z.object` is what makes step 2 safe on
the WS path. That reasoning is void: **the console never sends that frame.**
`ws-client.ts:133-141` presents its credentials the way the handshake does — a
`token` query parameter and a `bearer.<token>` subprotocol — and the api reads them
from the URL at `terminal.gateway.ts:1045`. So the identity rides a query parameter
on the same channel, and the safety property is simpler than the one claimed: an
api that does not read an unknown query parameter ignores it, with no schema
involved at all.

## Risks / Trade-offs

- **[The token is a new credential in CI]** → Scoped to deployment, created by the
  operator, never stored by this change. The release pipeline has been bitten by a
  token subtlety before (release-please needed a non-`GITHUB_TOKEN` PAT or the
  workflow silently did not fire), so the task asks for the deploy to be OBSERVED
  firing rather than assumed.

- **[Turning off the git production deploy strands the console if the release job
  fails]** → It fails visibly: no console ships, versus today's failure mode where
  a console ships that nobody compared against anything. The task keeps preview
  deployments so a change is still reviewable in a browser meanwhile.

- **[Fail-closed locks an operator out of their own console during an upgrade]** →
  Real, and the reason step 3 is ordered last. Between an api upgrade and a console
  release the console is refused — which is the intended meaning of "they move
  together", and is why B was chosen over A: the release moves both.

- **[A sentinel in local development now looks like a failure]** → Only when
  presented to an api. A locally built console talking to a locally built api is
  the ordinary dev loop and stays working; the refusal is on the identity being
  absent from something that reached a deployment.

## Migration Plan

No database, image, or wire-format change. The added identity field is additive on
both transports and ignored by an api that does not read it yet.

One out-of-repo act, in order: the operator creates the Vercel token and project
ids as repository secrets BEFORE the release job is enabled, or the first release
after this lands publishes no console. Rollback is re-enabling Vercel's git
production deploy — one field in `vercel.json`.

## Open Questions

None blocking. What this change deliberately does not answer — whether the closed
`.parse` on responses at `real.ts:1322` and the vocabulary-erasing casts get
converged — is recorded as a Non-Goal with its reasoning in D2.
