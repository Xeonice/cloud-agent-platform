# Verification Report — surface-quick-deploy-installer-on-www

Three-way adjudication of the verify pass. Each raw-unmet finding was re-traced
end-to-end against the actual code before routing.

## Tally

- Reopened (real code gap → verify-reopened task): 1
- Spec defects (→ design.md Open Questions): 0
- Reclassified MET (skeptic refuted, re-traces as satisfied): 5

## Re-trace pass (2026-06-25)

This pass received an empty raw-unmet list. The previously reopened gap (R.1,
prebuilt manual alternative) was re-traced end-to-end and confirmed implemented:
`prebuilt.manual` exists in the `content/index.ts` type (`ManualInstallContent`
on the prebuilt block), in `content/en.ts:59-67`, and in `content/zh.ts:57`; it
is rendered in `hero.tsx:113-145` as a `<details>` block next to the prebuilt
command (download the served `docker-compose.prod.yml`, then the prebuilt-compose
`up -d` steps). Task R.1 in tasks.md is checked off. No new code task is opened
and no new spec defect is recorded this pass. The single historically-reopened
gap below remains recorded for traceability (now satisfied).

## Reopened (UNMET — real code problem)

### Prebuilt installer is auditable and discloses caveats — Scenario: Inspectable URL and manual alternative disclosed

> Status (2026-06-25 re-trace): SATISFIED. The manual-alternative half is now
> implemented (see Re-trace pass above). Retained as a record of the prior
> reopen; no longer an open code gap.

The scenario requires BOTH (conjoined with "and"): the inspectable `quick-deploy.sh`
URL is shown, AND "the equivalent manual steps (download `docker-compose.prod.yml`,
run the prebuilt compose) are presented".

- The inspectable URL half is implemented: `hero.tsx:29,102` renders
  `prebuiltScriptUrl = https://<domain>/quick-deploy.sh`.
- The manual-alternative half has NO traceable implementation. `hero.prebuilt`
  (`content/en.ts:53-59`, `content/zh.ts:51-57`) has only `label` / `command` /
  `inspectLabel` / `caveat` — no `manual` field. The only manual block in
  `hero.tsx:115-149` renders `hero.manual` (the source-build `git clone && make up`
  path), not the prebuilt compose path. So the "download `docker-compose.prod.yml`,
  run the prebuilt compose" steps are not presented; a visitor wanting to avoid
  piping the prebuilt script to a shell has no disclosed alternative.

Routed to a verify-reopened code task (tasks.md → R.1). Not in design.md Open
Questions from a prior pass, so it is a new task, not a known spec defect.

## Reclassified MET (skeptic refuted; re-traced as satisfied)

1. **agent-oneclick-deploy — Scripted source-free prebuilt-image bring-up.**
   `scripts/quick-deploy.sh` carries the `__CAP_COMPOSE_BASE__` marker
   (line 51) with the in-file `case … __CAP_COMPOSE_BASE__)` fallback arm
   (lines 52-53), GATE 6 pulls + ups prebuilt images with no `--build`
   (lines 165-170), and `CAP_RAW_BASE` always wins. MET.

2. **agent-oneclick-deploy — Health verification and credential surfacing.**
   GATE 7 polls `http://localhost:${API_PORT}/health` (line 176), prints the
   bearer token, and the teardown hint includes `COMPOSE_PROFILES=web` when
   `WITH_WEB=1` (lines 184-187). MET.

3. **one-line-installer — Site-hosted prebuilt one-line installer (quick-deploy).**
   `inject-install-sh.mjs` stages `scripts/quick-deploy.sh` → `out/quick-deploy.sh`
   (lines 31-32), substitutes the marker (line 197), strips the dead fallback arm
   only when substituted (line 203), and asserts no `__CAP_` placeholder survives
   (lines 214-216). Single source-of-truth, no duplicate copy. MET.

4. **one-line-installer — Site-hosted prod compose asset.**
   The injector stages `docker-compose.prod.yml` → `out/docker-compose.prod.yml`
   (lines 35-36); the published `quick-deploy.sh` defaults its fetch base to the
   site; `CAP_RAW_BASE` override remains. MET.

5. **marketing-www — Landing information architecture.**
   All six sections render via `page.tsx`; both install commands appear with copy
   controls (`hero.tsx` install + prebuilt CommandBox blocks); features reflect
   real capabilities; security discloses host-root; bilingual en/zh. MET.

## Out-of-scope changes observed (scope findings, informational)

These were implemented but are not required by any spec in this change. Recorded
for traceability; not routed as tasks (no requirement to satisfy).

- `apps/www/public/install.sh:52-58` — `make` prerequisite check added to the
  source-build installer (re-traced 2026-06-25). Non-Goal: "Changing the
  `install.sh` source-build path"; design states the install.sh source-build path
  is unchanged.
- `scripts/dev-up.sh:77-79` — printed-note env var names / `web` profile note
  updated (re-traced 2026-06-25). No spec requirement touches `dev-up.sh` (dev
  convenience script, outside the install/deploy paths specified).
- `docs/self-hosting.md:370-400` — new section documenting `quick-deploy.sh` gates
  and the trust boundary. No spec requirement mentions updating `docs/self-hosting.md`.
- `legacy-token-synthesized-env.test.mjs:1-173` — new GATE 5 test file at repo root.
  Tests GATE 5 of the prior (already-archived) change's spec, not anything in this
  change's specs.
