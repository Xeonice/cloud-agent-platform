## Context

The custom sandbox image flow crosses API contracts, provider validation,
console UI, and self-host documentation. The desired product boundary is now
clear: CAP is a control plane. Operators build and publish custom images with
their own Docker/CI/registry workflow, then admins register the resulting image
reference in CAP and validate it through the configured sandbox provider.

The current implementation already accepts only two managed environment source
kinds: `aio-docker-image` and `boxlite-image`. However, the archived OpenSpec
contract still references legacy managed sources such as AIO already-loaded
Docker images and BoxLite rootfs paths. That mismatch makes the product look
like it might own upload, build, or local rootfs management in the image
library.

## Goals / Non-Goals

**Goals:**

- Make managed sandbox environments registry-image-only.
- Make `/images` an admin-only image reference registration and validation
  surface.
- Keep ordinary users on a simple ready-image selection flow in settings and
  task creation.
- Keep BoxLite rootfs support as deployment-level configuration only.
- Provide a clear extension path through official base-image templates and
  external build/push instructions.

**Non-Goals:**

- Build images inside CAP.
- Upload tarballs or OCI layouts through CAP.
- Host a registry or proxy registry pulls.
- Store registry credentials in CAP image records.
- Configure provider-host registry access from CAP.
- Expose BoxLite rootfs as a per-user or per-task managed image option.

## Decisions

1. Managed environment sources stay limited to registry image references.

   Rationale: this matches the current contract implementation, keeps image
   records non-secret, and lets validation prove the provider host can pull and
   run the image. The alternative was to add upload/rootfs/local-image source
   types, but that would make CAP responsible for artifact distribution and
   host-specific storage semantics.

2. Admins register image references; users select ready images.

   Rationale: registry access, image lifecycle, and runtime compatibility are
   operational concerns that require admin privileges. User settings should only
   store a ready environment id and should not expose image maintenance controls.
   The alternative was to let every user add image refs, which would broaden the
   security and support surface without solving registry access.

3. Validation remains provider-backed rather than a static form check.

   Rationale: the important question is whether the actual Docker or BoxLite
   host can pull, start, and probe the image. Static syntax checks cannot catch
   private registry authorization, architecture mismatch, missing runtime tools,
   or provider create/start failures.

4. BoxLite rootfs remains a deployment default.

   Rationale: rootfs paths are host-local deployment state. They are useful for
   release assets and advanced same-host BoxLite defaults, but they are not
   portable image-library records and cannot safely follow users across
   providers or hosts.

5. Documentation and UI copy use registration language.

   Rationale: "add image" or "upload image" can imply CAP owns artifact
   creation or storage. The UI should ask for an already-published image
   reference and call the operation "注册镜像" / "保存引用".

## Risks / Trade-offs

- Operators expect CAP to build or upload images -> Mitigation: put the
  external build/push chain in the help page and registration form.
- Private registry validation fails after a correct CAP registration ->
  Mitigation: surface provider-host registry reachability and authorization
  errors without storing registry secrets.
- BoxLite rootfs users need a local deployment path -> Mitigation: keep
  rootfs documented in self-host deployment docs, outside `/images`.
- Spec drift reintroduces legacy sources -> Mitigation: make the OpenSpec
  source-kind contract explicit and include tests/tasks that verify rejected
  legacy source kinds.

## Migration Plan

1. Update OpenSpec source-kind requirements to remove legacy managed sources.
2. Audit API/contracts to confirm only `aio-docker-image` and `boxlite-image`
   are accepted.
3. Update console copy from add/import/upload wording to register/reference
   wording.
4. Update help docs and templates so the operator path is: extend official base
   image, build externally, push externally, register reference in CAP, validate.
5. Verify non-admin users cannot manage images and can only select ready images.

Rollback is low risk because the intended runtime contract already rejects the
legacy managed source kinds. If UI/document changes need rollback, the existing
provider and task provisioning behavior can remain unchanged.

## Open Questions

- None for this proposal. Future work can consider richer registry diagnostics,
  but not registry credential management or image building inside CAP.
