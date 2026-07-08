## MODIFIED Requirements

### Requirement: Custom sandbox image documentation covers registry operations

The project SHALL document how operators build, tag, push, register, validate,
and maintain custom AIO and BoxLite sandbox images using pinned image
references. The documentation SHALL make registry responsibilities explicit:
CAP does not build images, upload image artifacts, host a registry, publish
images, or store registry credentials, and the Docker host or BoxLite host must
be able to pull the image before CAP validation can pass. The documentation
SHALL call out GHCR package write permissions and private package visibility
when GHCR is used.

#### Scenario: External build and push chain is documented

- **WHEN** an operator follows the custom image guide
- **THEN** the guide tells them to extend the official AIO or BoxLite base image
  for the running CAP version
- **AND** it tells them to build and push the resulting image outside CAP before
  registering the image reference in CAP

#### Scenario: GHCR package permission requirements are documented

- **WHEN** an operator follows the custom image guide using GHCR
- **THEN** the guide tells them that pushing a custom package requires package
  write permission such as `write:packages`
- **AND** it tells them that the provider host must be able to pull the package
  with appropriate visibility or registry authentication

#### Scenario: Private registry reachability is documented

- **WHEN** an operator uses a private or internal registry for a custom image
- **THEN** the guide states that CAP stores only the non-secret image reference
- **AND** the Docker host or BoxLite host must be configured separately to pull
  that image before validation can pass

### Requirement: BoxLite deployment-default custom rootfs path is documented

The self-host documentation SHALL describe the advanced BoxLite
deployment-default customization path for operators who need a same-host custom
default without a managed image-library selection. The documented path SHALL
extend the official BoxLite sandbox image for the running CAP version, export a
Linux OCI rootfs layout for the BoxLite host architecture, configure
`BOXLITE_ROOTFS_PATH`, restart the API, and run a create/start/exec/delete probe.
The documentation SHALL state that this rootfs path is a deployment-level
default, not a managed image-library source, not a user default-image option, and
not a per-task image override.

#### Scenario: Operator configures a BoxLite rootfs deployment default

- **WHEN** an operator follows the advanced BoxLite rootfs guide
- **THEN** they can build or export an OCI rootfs layout, set
  `BOXLITE_ROOTFS_PATH`, restart the API, and verify BoxLite can start and exec
  from that rootfs
- **AND** new tasks without a managed image selection use that deployment-level
  default

#### Scenario: Rootfs path is not presented as a managed image source

- **WHEN** the self-host documentation explains BoxLite rootfs customization
- **THEN** it states that rootfs is not registered in `/images`
- **AND** managed image-library customization remains based on pinned registry
  image references
- **AND** rootfs does not appear in user default-image or task image selection
