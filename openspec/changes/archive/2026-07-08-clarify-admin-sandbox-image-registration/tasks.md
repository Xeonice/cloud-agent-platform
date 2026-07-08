## 1. Track: contracts-api-boundary (depends: none)

- [x] 1.1 Audit `@cap/contracts` sandbox environment schemas and ensure managed source kinds are limited to `aio-docker-image` and `boxlite-image`.
- [x] 1.2 Ensure the sandbox environment create path rejects already-loaded image, rootfs path, upload artifact, and unknown managed source kinds before validation.
- [x] 1.3 Ensure managed environment validation and resolution metadata describe registry image references/digests, not rootfs paths or local loaded-image handles.
- [x] 1.4 Add or update API/contract tests covering accepted AIO and BoxLite image references plus rejected legacy source kinds.

## 2. Track: frontend-registration-flow (depends: contracts-api-boundary)

- [x] 2.1 Update `/images` admin copy and controls to use registration/reference language such as `注册镜像` and `保存引用`.
- [x] 2.2 Ensure the registration form asks for an already-published image reference and does not present upload, build, loaded-image, or rootfs-source controls.
- [x] 2.3 Keep `/settings` as a plain user default-image dropdown with no image-library management controls.
- [x] 2.4 Add or update web tests for admin-only image registration controls, non-admin management gating, and user-only default selection.

## 3. Track: docs-templates-guidance (depends: none)

- [x] 3.1 Update custom sandbox image docs and in-console help so the supported chain is extend official base image, build externally, push externally, register reference in CAP, validate.
- [x] 3.2 State explicitly that CAP does not build, upload, host, publish, or store registry credentials for custom images.
- [x] 3.3 Keep BoxLite rootfs documented only as an advanced deployment-level default and state that it is not registered in `/images` or selectable by users.
- [x] 3.4 Verify AIO and BoxLite template Dockerfiles preserve the task user and workspace and do not produce avoidable empty `FROM` warnings with documented build args.

## 4. Track: boxlite-provider-boundary (depends: contracts-api-boundary)

- [x] 4.1 Ensure BoxLite managed environment provisioning accepts only resolved `boxlite-image` registry references.
- [x] 4.2 Ensure BoxLite deployment-level `BOXLITE_ROOTFS_PATH` and rootfs maps still work only as omitted-environment defaults.
- [x] 4.3 Add or update BoxLite provider tests proving managed rootfs environment selection is rejected while deployment-level rootfs fallback still works.

## 5. Track: verification (depends: frontend-registration-flow, docs-templates-guidance, boxlite-provider-boundary)

- [x] 5.1 Run focused contract/API tests for sandbox environment source validation and resolution.
- [x] 5.2 Run focused BoxLite provider tests for image environment and deployment-rootfs behavior.
- [x] 5.3 Run focused web tests for `/images`, settings default image selection, and help route rendering.
- [x] 5.4 Run the relevant package typecheck/lint/build commands required by the touched files.
- [x] 5.5 If UI changed, verify `/images`, `/settings`, and `/help/sandbox-images` in a browser screenshot pass.
