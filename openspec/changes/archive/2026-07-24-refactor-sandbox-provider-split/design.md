## Context

Before this split, the API package owned both orchestration policy and concrete sandbox mechanics. That made the local AIO path tightly coupled to the control plane and forced unrelated concerns to import API-local types. The immediate pressure came from two needs:

- support optional managed/cloud sandbox providers without rewiring Guardrails, transcript reads, or retention;
- make e2e tests assert product contracts instead of implementation timing details.

## Goals / Non-Goals

**Goals:**

- Move reusable sandbox contracts, provider selection, lifecycle planning, workspace clone planning, and provider adapters into dedicated packages.
- Keep `@cap/api` responsible for orchestration, auth, audit, task lifecycle, and terminal gateway behavior, not provider internals.
- Allow local and cloud providers to coexist behind one capability-based facade.
- Preserve the self-host local AIO behavior as the default.
- Lock the new boundaries with focused package tests, conformance coverage, and live AIO e2e.

**Non-Goals:**

- Replacing the local AIO self-host topology.
- Making the Docker socket topology multi-tenant safe.
- Claiming cloud providers support capabilities their HTTP adapter has not enabled.
- Changing the browser terminal protocol.

## Decisions

- **Provider descriptors are the scheduling unit.** Providers advertise id, location, priority, and capabilities. Selection requires all requested capabilities, then orders by priority and optional preferred location.
- **Provision input is planned before provider selection.** The API resolves a per-task clone spec through the provision lookup, builds a provision plan, then passes only provider-neutral inputs to the selected provider.
- **AIO implementation moves behind package boundaries.** API-local `AioSandboxProvider` is reduced to wiring; Docker/container specifics live under the AIO packages.
- **Retention is provider-neutral.** The cleanup path depends on a retention store/provider surface rather than assuming retained `cap-aio-*` containers are the only possible source.
- **Transcript reads use runtime/provider materialization.** Controllers receive provider-returned transcript sources and dispatch parsing by runtime format.
- **Reconnect replay must observe durable ordering.** The gateway flushes the per-task append chain before reading `session.log`, closing the gap where the old socket had seen output but the reconnecting client got an empty tail.
- **AIO e2e tests black-box behavior, not shell timing.** Clone assertions execute inside the real per-task sandbox container, codex startup asserts auto-launch/CPR behavior, and reconnect retries across the async auth window.

## Risks / Trade-offs

- More packages increase workspace build surface, so package-level coverage and conformance checks are required.
- The cloud HTTP provider is intentionally capability-gated; setting `CAP_SANDBOX_CLOUD_HTTP_CAPABILITIES=all` before the backend implements every endpoint would be an operator error.
- Local AIO still depends on Docker-out-of-Docker and is host-root-equivalent; this change improves architecture boundaries, not the self-host security model.
- The e2e suite is heavier because it validates real compose + Docker behavior; targeted package tests cover the faster feedback loop.
