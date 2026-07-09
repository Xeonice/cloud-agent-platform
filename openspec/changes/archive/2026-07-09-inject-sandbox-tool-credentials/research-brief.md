## Research Brief

The product decision is to manage third-party tool tokens as admin-configured image parameters, not as user-level task forge credentials.

### Current Code

- Custom images are represented by `SandboxEnvironment`.
- Image Management is admin-only and already owns image registration/validation.
- AIO and BoxLite both execute host-harness setup commands before runtime launch.
- Existing environment metadata and sandbox run metadata are intended to be non-secret.

### Target Model

- Admin registers an AIO/BoxLite image and optional parameters.
- Plain parameters can be shown in reads.
- Secret parameters are encrypted at rest and are write-only after saving.
- Task provisioning resolves parameters from the selected/default environment.
- Providers write `/home/gem/.cap/image-env` before agent runtime setup.
- Custom image wrappers source that file before launching third-party tools.

### Rejected Direction

The previous task-owner forge credential design was rejected because it couples image tools to user identity and repository host matching. That is too complex for admin-maintained custom images and does not generalize cleanly to tools that are not forge-related.
