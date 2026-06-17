# Verification Report — self-update-resident-topology

Adversarial spec verification (post-apply). Three-way routing of findings:
UNMET → verify-reopened code task; SPEC-DEFECT → design.md Open Question; MET → folded here.

## Adjudication summary

- Raw-unmet count from the skeptic pass: **0** (no requirement was flagged unmet).
- Re-traced both modified requirements (8 scenarios total) against the actual code
  (`apps/api/src/self-update/self-update.service.ts`, `self-update.controller.ts`,
  `self-update.spec.ts`). **All 8 scenarios re-trace as satisfied.**
- Verify-reopened code tasks added this pass: **0**.
- New Open Questions added this pass: **0**.

## MET requirements (re-traced end-to-end)

### Requirement 1 — "The upgrade target is bounded — validated version, cap namespace, cap services only" — MET

| Scenario | Implementation | Evidence |
|---|---|---|
| Target must match the reported latest | `planUpdate` cross-checks the normalized target against `updateStatus.getStatus()`; refuses `target-mismatch` when not `updateAvailable`, `latestVersion === null`, or `!versionsMatch(...)`. | `self-update.service.ts:236-249` |
| Only the cap namespace + services are touched | `CAP_IMAGE_RE = /(^|\/)ghcr\.io\/[^/]+\/cap-[^/:@\s]+/i` filters the project's containers to cap-* images; `buildPlan` scopes `pull`/`up -d` to exactly the derived `services`. | `self-update.service.ts:40, 404-418, 310-342` |
| Topology is derived from the running deployment, not fixed literals | `DockerTopologyResolver.resolve()` reads `com.docker.compose.project` / `.project.config_files` / `.project.working_dir` off the api's own container (`os.hostname()` → inspect). | `self-update.service.ts:381-421` |
| A deployment without compose labels falls back to operator env | `resolve()` returns `null` when any label is absent; `planUpdate` then uses `fallbackTopology()` (operator env overrides, else documented literals) and refuses `no-cap-service` when zero cap services resolve. | `self-update.service.ts:392-398, 254-262, 292-300` |

The topology is sourced from Docker labels (set at deploy time), never from the request body — the request only confirms the cross-checked target, so the "no new client input surface" bound holds.

### Requirement 2 — "Self-recreate uses a detached updater and preserves running tasks" — MET

| Scenario | Implementation | Evidence |
|---|---|---|
| The api recreates itself via a detached updater | `DockerUpdaterLauncher.launch()` creates + starts a one-shot helper container (own container, `AutoRemove`, host network, docker.sock + working-dir binds) and returns immediately; the controller acks 202 before the api restarts. | `self-update.service.ts:438-473`; `self-update.controller.ts:71` (`@HttpCode(HttpStatus.ACCEPTED)`) |
| Running tasks survive the upgrade | Delegated by the spec's own wording to `survive-api-redeploy`'s re-adoption + existing WebSocket auto-reconnect; both are already-shipped mechanisms. No new implementation is required here per the spec. | spec.md req-2 ("preserved via `survive-api-redeploy`'s re-adoption"); `survive-api-redeploy` shipped (MEMORY: survive-api-redeploy-shipped) |
| A failed pull does not break the running version | The script joins `ensure && pin && pull && up` with `&&`, so a failed `pull` aborts before `up -d`; `commands: [pull, up]` preserves pull-then-recreate order. | `self-update.service.ts:315-316, 332, 339` |
| The upgraded version persists across a later manual up | The `pin` step atomically rewrites `CAP_VERSION=<target>` into the working-dir `.env` (`grep -v ... ; echo ... > .env.captmp && mv .env.captmp .env`), so a later manual `up -d` reads the new pin. | `self-update.service.ts:329-331` |

## Containment bounds (re-asserted, all preserved)

- Four layered gates intact: operator 401 → admin 403 (`SELF_UPDATE_ADMINS`) → `disabled` 404 → bounded-target 422. `disabled` → 404, all other refusals → 422. (`self-update.controller.ts:112-115`)
- `/update-status` server-side cross-check retained (`planUpdate`).
- Strict semver-tag validation (`isSemverTag`) rejects moving tags / shell metacharacters / arbitrary image refs.
- Updater never names postgres/loki/grafana/ghcr-foreign images — the service set is reality-derived to `ghcr cap-*` only (a tighter bound than the prior fixed list).
- Detached launch (`AutoRemove`, host network) outlives the api recreate.

## Non-blocking scope / surface notes (no requirement violated)

1. **Three new fallback env vars** — `SELF_UPDATE_COMPOSE_FILES` (`self-update.service.ts:66`),
   `SELF_UPDATE_PROJECT` (`:67`), `SELF_UPDATE_SERVICES` (`:68`). The proposal cites only
   `SELF_UPDATE_COMPOSE_DIR` as the fallback *example* ("e.g."), but spec.md req-1 licenses the
   fallback generically ("the updater MAY fall back to operator-set env overrides", plural) and
   design D1 keeps "B's env knobs … as a FALLBACK when labels are absent." These three knobs are
   the per-field fallback overrides for project / `-f` files / services — squarely inside the
   spec's licensed fallback surface and only ever consulted when compose labels are absent.
   **In-scope; not a spec defect; non-blocking.** Worth a one-line mention in DEPLOY.md so the
   operator-facing fallback knobs are documented, but not a code task.

2. **`no-cap-service` → 422 (uniform with `invalid-target` / `target-mismatch`)** — the spec
   names the `no-cap-service` refusal but does not pin its HTTP code; mapping it to 422 is a
   defensible operator-error code and does not contradict the spec. Indistinguishable from the
   other 422 refusals at the HTTP layer, which is acceptable since all are operator/request-side
   refusals. **Non-blocking.**

3. **`TOPOLOGY_RESOLVER` / `UPDATER_LAUNCHER` ports + `UpdateTopology`/`TopologyResolver` exported
   symbols** — these are the DI seams the tasks call for ("injected behind a `TOPOLOGY_RESOLVER`
   port so tests supply a fake"). Exporting them widens the module's public API slightly but is the
   intended test-isolation mechanism. **In-scope; non-blocking.**

## Verdict

Both modified requirements of `self-update-action` (as redefined by this change) are MET. No
verify-reopened code task and no new Open Question were warranted by this pass. The only findings
are non-blocking scope/surface notes recorded above. The non-USER-GATED tasks (Tracks 1-3) are
complete; Track 4 (rollout-verify) remains user/maintainer-gated by design.
