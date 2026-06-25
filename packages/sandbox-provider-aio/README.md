# @cap/sandbox-provider-aio

AIO/Docker sandbox provider lifecycle controller.

This package owns the provider mechanism that is not app-specific:

- create/start deterministic `cap-aio-<taskId>` containers;
- track live container handles and addressable connections;
- wait for AIO readiness;
- run `/v1/shell/exec` commands and parse AIO responses;
- stop-only teardown and force-remove cleanup;
- startup readoption scan and reattach bookkeeping;
- retained transcript tar extraction from stopped containers.

It deliberately does not import Nest, Prisma, runtime registries, credential
sources, skill allowlists, or task lookup ports. The API composes those app
ports around this controller.
