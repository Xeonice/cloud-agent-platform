# Verification Report: self-update-ensure-updater-image

## Summary

The change adds a single spec requirement with two scenarios, both verified MET
against the live `DockerUpdaterLauncher` in
`apps/api/src/self-update/self-update.service.ts`.

| Outcome | Count |
| --- | --- |
| MET | 1 |
| UNMET (verify-reopened) | 0 |
| SPEC-DEFECT (open question) | 0 |

## MET Requirements

### Requirement: The updater image is ensured present before the updater container is created

Re-traced end-to-end and confirmed satisfied; the skeptic raised no blocking
refutation.

- `DockerUpdaterLauncher.launch()` calls `await this.ensureImage(image)` at
  line 443 — i.e. BEFORE `this.docker.createContainer(...)` at line 453. This
  satisfies the spec clause "ensure that updater image is present locally BEFORE
  creating the updater container" and the ordering scenario (pull/ensure then
  createContainer).
- `ensureImage` (lines 478–491) implements inspect-then-pull-on-miss:
  - `await this.docker.getImage(image).inspect()` then `return` on success —
    the steady-state path performs no pull and stays offline-friendly
    (Scenario: "A host that already staged the updater image does not re-pull").
  - On a thrown error (image absent) it falls through to `this.docker.pull(image)`
    and awaits completion via `this.docker.modem.followProgress(stream, ...)` —
    a fresh host self-heals by pulling first (Scenario: "A fresh host with no
    updater image self-heals"), instead of `createContainer` 404-ing with
    "no such image".
- The image source matches the spec: `nonEmptyEnv(this.env[UPDATER_IMAGE_ENV])
  ?? DEFAULT_UPDATER_IMAGE` (line 439) — the `SELF_UPDATE_UPDATER_IMAGE` override
  with the `docker:27-cli` default.
- Scope of the requirement is respected: only the helper image is ensured here;
  the cap GHCR target images remain pulled by the updater's own
  pull-then-recreate compose step (no code touching those was added).

## Gap / Scope Findings

### Gap

The spec has only one requirement, with two scenarios:

1. Requirement: "The updater image is ensured present before the updater
   container is created"
   - Scenario 1: Fresh host with no updater image self-heals
     (inspect → pull → create container)
   - Scenario 2: Host that already staged the updater image does not re-pull
     (inspect → create container directly)

Looking at `DockerUpdaterLauncher.launch()`:
- Line 443: `await this.ensureImage(image);` is called before `createContainer`.
- Lines 478–491: `ensureImage` inspects first, returns early if present, pulls
  only on a miss.

Both scenarios are fully implemented. The `ensureImage` method directly
implements the requirement: inspect first, pull only when absent, skip pull when
already staged. No gap that blocks the primary scenario.

### Scope

The only file touched by this change is `self-update.service.ts`. (Any other
modified files in the working tree — e.g. `agent-runtime.integration.ts`,
`provision-lookup.port.ts` — belong to a different change.)

The implementation adds exactly two things:
1. The `ensureImage` private method (lines 478–491): inspect → return if present;
   catch → pull via `followProgress`. Directly implements "inspect first, pull
   only on a miss".
2. The `await this.ensureImage(image)` call in `launch` (line 443): ensures the
   image before `createContainer`. Directly implements "ensure updater image is
   present BEFORE creating the updater container".

There are no behaviors in the implementation that lack a corresponding spec
requirement. Every line of the new code traces to one of the spec scenarios
(fresh-host self-heal, steady-state no-pull, pull-then-createContainer ordering).
