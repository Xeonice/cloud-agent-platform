## Context

`simplify-sandbox-image-model` reduced the product model to two managed custom
image sources: AIO image and BoxLite image. That remains the right boundary.
However, the live `vibe-zlyan` customization exposed operational gaps:
registry access failures are hard to interpret, failed test imports remain in
the image library, BoxLite validation cleanup can target the wrong id, and the
only practical same-host BoxLite default path uses deployment-level
`BOXLITE_ROOTFS_PATH` without clear operator guidance.

The current contracts already include a `disabled` sandbox environment status,
but the API and console do not expose a lifecycle action for admins to move a
bad or obsolete image record out of use. BoxLite validation already creates
short-lived sandboxes, but cleanup should use the actual provider sandbox id
returned by BoxLite, not only the requested probe name.

## Goals / Non-Goals

**Goals:**

- Preserve the simplified managed image model: AIO image and BoxLite image
  references only.
- Let admins retire failed or obsolete image records without database edits.
- Ensure retired image records are not selectable, cannot be defaults, and are
  cleared if they were defaulted.
- Make BoxLite validation cleanup robust when the provider returns a generated
  box id.
- Improve validation error output for private registry, GHCR permission,
  unreachable registry, and HTTP-only registry cases.
- Make the custom image templates warning-free and easier to copy.
- Document both supported paths:
  - managed image library via registry image references;
  - advanced BoxLite deployment default via OCI rootfs and `BOXLITE_ROOTFS_PATH`.

**Non-Goals:**

- Reintroducing `boxlite-rootfs` or `aio-loaded-docker-image` as managed image
  source types.
- Hosting a registry, storing registry credentials, or configuring BoxLite
  insecure registry support inside CAP.
- Browser upload of Docker image or rootfs artifacts.
- Building custom images inside CAP.
- Physically deleting sandbox environment rows in the first pass.

## Decisions

### 1. Use `disabled` as the retire state instead of hard delete

Admins will get a lifecycle action that marks an environment `disabled`.
Disabled environments remain auditable, keep validation history, and are
excluded from defaults and task selection by the same selectable-status checks
that already reject non-ready environments.

If the disabled environment is the global default, the API will clear its
default marker in the same transaction. User-level default settings that point
at disabled environments should be treated like any other non-selectable
default: ignored or rejected on save, never used for new task admission.

Alternative considered: hard delete rows. Rejected for the first pass because
environment ids can appear in task/run metadata and validation history. Hard
delete is useful later, but it needs retention rules and clearer audit
semantics.

### 2. Keep registry access as an operator responsibility, but classify failures

CAP will not store registry tokens or attempt to repair provider host registry
configuration. Validation remains the proof point that the provider host can
pull and run the image.

The improvement is in reporting: known pull/transport failures should produce
non-secret, actionable validation messages. Examples include missing registry
credentials, unauthorized/private package access, DNS/connectivity failure,
architecture mismatch, and HTTP registry rejected by an HTTPS-only pull path.

Alternative considered: add registry credentials to the image-library form.
Rejected because it expands CAP's secret surface and does not solve provider
specific registry setup consistently across Docker and BoxLite.

### 3. Delete the actual BoxLite sandbox returned by create

BoxLite native create may accept a requested probe name but return a generated
box id. Validation must track the `sandbox.id` returned by `createSandbox()` and
delete that id in `finally`. If create fails before returning an id, cleanup can
fall back to the requested probe id as a best-effort guard.

Alternative considered: rely on deterministic names. Rejected because the live
native API returned generated ids, and cleanup by requested name may silently
miss the created box.

### 4. Document BoxLite rootfs as deployment default only

The advanced same-host flow should be documented as:

1. Extend `ghcr.io/xeonice/cap-boxlite-sandbox:<cap-version>`.
2. Build for the BoxLite host architecture.
3. Export an OCI layout using a buildx driver that supports `--output type=oci`.
4. Place it under the deployment assets directory.
5. Set `BOXLITE_ROOTFS_PATH` and restart the API.
6. Run a BoxLite create/start/exec/delete probe.

This is explicitly the fallback/default source when no managed environment is
selected. It must not appear in `/images` as a custom image source type.

Alternative considered: expose this as "BoxLite rootfs" in the image library
again. Rejected because it reintroduces the product confusion that the simplified
model removed.

### 5. Keep template and docs content single-sourced enough to test

The two existing operator docs can remain separate files, but they should carry
the same critical sections and examples. The implementation should add a
lightweight static check for important phrases/paths, including GHCR package
permissions, HTTPS/private registry reachability, `BOXLITE_ROOTFS_PATH`, and
the template files.

The Dockerfile templates should avoid BuildKit warnings by using a valid default
or explicit version placeholder that produces a valid base image when linted.

Alternative considered: make the web help page import the repository docs file
directly. Rejected for now because the current in-console markdown route already
has its own content file and changing content packaging is unnecessary for this
hardening pass.

## Risks / Trade-offs

- [Disabled rows accumulate] -> They remain non-selectable and auditable; hard
  delete can be added later with retention semantics if operators need pruning.
- [Validation messages leak sensitive data] -> Only classify and summarize
  provider errors; do not store tokens, auth headers, full registry credential
  output, or task secrets in validation probes.
- [Rootfs documentation is mistaken for a user image feature] -> Label it
  "deployment-level server default" and keep `/images` instructions registry
  based.
- [BoxLite provider error strings vary by version] -> Normalize broad classes
  with conservative matching and keep the raw provider failure summarized under
  validation details for debugging.
- [Template defaults drift from release tags] -> Use a documented placeholder or
  stable default and continue recommending explicit `--build-arg CAP_VERSION`.

## Migration Plan

1. Add the retire/disable API and service behavior, backed by tests proving
   disabled environments are not defaulted or selectable.
2. Add frontend image-library controls and copy for retiring failed/obsolete
   records, then refresh the image list after mutation.
3. Update BoxLite validation cleanup to track the returned sandbox id and add
   tests for generated ids and create failures.
4. Add provider validation error classification for registry/pull failures.
5. Update Dockerfile templates and both custom image docs.
6. Add static docs/template checks and targeted test coverage.
7. Run `openspec validate harden-sandbox-image-operations --strict` plus
   targeted contract/API/provider/frontend/doc tests.

Rollback is a normal code rollback before release. Disabling environments is
stateful; if rollback is needed after records were disabled, an operator can
re-enable through a follow-up DB/admin action only if implemented. This change
does not physically delete data.

## Open Questions

- Should the console label the lifecycle action "停用", "归档", or "移出列表"?
- Should a disabled environment be restorable in the first implementation, or
  is one-way disable sufficient for the initial operator cleanup flow?
