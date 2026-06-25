# @cap/sandbox-aio-local

Pure configuration helpers for the local AIO/Docker sandbox provider.

This package deliberately does not import Nest, dockerode, Prisma, or runtime
credential ports. The application-owned provider still performs Docker and
runtime orchestration; this package owns the stable local adapter contract:

- deterministic `cap-aio-<taskId>` naming;
- internal AIO HTTP/WS URLs;
- pinned image validation;
- Docker-compatible container create options;
- local provider descriptor metadata;
- workspace and lifecycle timeout constants.

The package is the local counterpart to `@cap/sandbox-cloud-http`. Both adapter
packages register against `@cap/sandbox` provider descriptors and capability
vocabulary.
