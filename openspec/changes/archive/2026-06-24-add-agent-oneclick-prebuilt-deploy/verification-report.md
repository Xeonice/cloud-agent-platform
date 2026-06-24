# Verification Report — add-agent-oneclick-prebuilt-deploy

This report folds in requirements that re-trace end-to-end as MET despite a skeptic's
refutation (including met-as-written with a minor, non-blocking implementation gap), plus
the gap/scope findings surfaced during adjudication.

## Reclassified MET

### Optional provision smoke (agent-oneclick-deploy) — MET (met-as-written, non-blocking gap)

Spec (`specs/.../spec.md:124-141`) requires an opt-in provision smoke that (1) creates a
throwaway task, (2) confirms the per-task sandbox provisions (task reaches `running`), (3)
stops it, (4) is skipped-with-warning when no credential/repo is available — "reusing the
existing boot-smoke logic rather than reimplementing it."

Re-trace of `scripts/quick-deploy.sh` GATE 8 (lines 189-212):
- Opt-in: gated on `RUN_SMOKE=1` (line 189). ✓
- Create throwaway task: `POST /repos/$CAP_SMOKE_REPO_ID/tasks` (lines 197-200). ✓
- Confirm sandbox provisions: polls `GET /tasks/$tid` until `status==running` (lines 203-208). ✓
- Stop it: `POST /tasks/$tid/stop` (line 209). ✓
- Skip-with-warning when no prerequisite: `CAP_SMOKE_REPO_ID` unset → `warn` + skip, bring-up
  still succeeds (lines 191-193). ✓

Both scenarios ("Smoke confirms sandbox provisioning when enabled" / "Smoke skipped without
prerequisites") are functionally satisfied.

The skeptic's refutation targets only the implementation-note clause "reusing the existing
boot-smoke logic rather than reimplementing it." That clause does not re-trace as a true code
defect for two reasons:

1. The spec's named prior art is wrong (authoring error). `scripts/boot-smoke.sh` boots the
   BUILT @cap/api orchestrator against a throwaway Postgres and probes `/health` for a healthy
   DI/bootstrap (see `scripts/boot-smoke.sh:1-20`). It has nothing to do with task provisioning
   and is genuinely NOT reusable for a "create+confirm+stop a throwaway task" smoke. The real
   prior art is `scripts/upgrade.sh`'s provision smoke (`upgrade.sh:89-124`), which GATE 8
   explicitly mirrors (`quick-deploy.sh:187` comment: "Mirrors scripts/upgrade.sh's smoke").
2. "Reusing rather than reimplementing" is an implementation note, not an outside-observable
   behavioral requirement. The behavior an observer can verify — create task → reach `running`
   → stop — IS present and correct.

This routes to MET (met-as-written with a minor, non-blocking gap): the gate is an inline
mirror of `upgrade.sh` rather than a shared extracted helper, and it lacks the early-break on
`status==failed/agent_failed_to_start` that `upgrade.sh:110` has (so a failed task waits out the
full 180s deadline before dying). Neither blocks either scenario.

## Gap finding

`scripts/boot-smoke.sh` is a completely different kind of smoke test — it boots the built API
from source against a throwaway Postgres and probes `/health`. It is NOT the same as the
"create+confirm+stop a throwaway task" provision smoke. The spec says "reusing the existing
boot-smoke logic rather than reimplementing it," but looking at what `boot-smoke.sh` actually
does, it is not reusable for the task-provision smoke. The spec comment appears to reference
`upgrade.sh`'s smoke. The actual GATE 8 implementation is an inline mirror of `upgrade.sh`.

However, the requirement's key stated behavior is "creates a throwaway task, confirms the
per-task sandbox provisions (the task reaches a running state), then stops it." GATE 8 does
exactly this. "Reusing boot-smoke logic" is an implementation note, not a behavioral
requirement testable by an outside observer.

On the "Missing make" scenario and whether `out/install.sh` is a "no traceable implementation"
gap: the adjudication is stricter than the original draft below. The `make` preflight is NOT in
the committed HEAD of either `apps/www/public/install.sh` (HEAD checks only `git`+`docker` then
clones then runs `make`) or `apps/www/out/install.sh`. It exists ONLY as an uncommitted
working-tree edit. The served source-of-truth (`curl | sh`) therefore still clones-then-fails,
violating the scenario. This is routed as a real UNMET code task (verify-reopened R.1), not a
mere build-artifact staleness issue, because the committed source itself does not carry the
behavior.

## Scope / scope-creep findings

Behaviors implemented with no backing spec requirement (informational; not blocking):

- `WITH_WEB` defaults to 1, making the `web` profile opt-OUT rather than opt-in as the spec
  implies ("opt-in `web` profile for the localhost trial"). — `scripts/quick-deploy.sh:43`
- `REPO_ROOT`/`SCRIPT_DIR` detection and local compose file copy / use-in-place fallback
  (multi-branch GATE 4 logic beyond "fetch from env-overridable base"). —
  `scripts/quick-deploy.sh:48-49,117-129`
- `CAP_WORKDIR` env-tunable for a user-configurable working directory — no spec requirement. —
  `scripts/quick-deploy.sh:40`
- `API_PORT` / `WEB_PORT` env-tunables — not mentioned in any spec requirement. —
  `scripts/quick-deploy.sh:41-42`
- `CAP_RAW_BASE` env-tunable exposing the download base URL to callers — only in task notes, not
  a requirement. — `scripts/quick-deploy.sh:46`
- `docker version --format` printed after the engine OK gate — no requirement to surface Docker
  server version. — `scripts/quick-deploy.sh:111`
- `dev-up.sh` closing message adds a teardown command reference (`scripts/dev-down.sh`) — spec
  only requires fixing the stale `VITE_*` / compose `web` profile copy. — `scripts/dev-up.sh:80`
- `dev-up.sh` closing message adds a per-task sandbox lifecycle note — spec only requires fixing
  the stale `VITE_*` / compose `web` profile copy. — `scripts/dev-up.sh:74-76`
- `apps/www/out/install.sh` not updated with the `make` preflight (task 2.2 required syncing
  `public`→`out`) — under-delivery against spec, folded into verify-reopened R.1, not scope creep.
  — `apps/www/out/install.sh:44-61`
