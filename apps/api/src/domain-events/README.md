# `domain-events/` — the in-process domain event bus

The mechanism the phase-4 migrations are built on: a process-local, synchronous
bus with per-subscriber isolation, published to by the lifecycle seams and
subscribed to by nobody yet. Zero subscribers is deliberate — this change builds
the mechanism and changes no behaviour (`add-domain-event-bus`).

| File | Role |
| --- | --- |
| `domain-event-bus.port.ts` | The port: interface, DI tokens, registration types, and the compile-time subscriber guard. Publishers import ONLY this. |
| `domain-event-bus.service.ts` | The implementation: validate, then dispatch synchronously with one error boundary per subscriber. |
| `domain-event-publishing-cutover.port.ts` | The publish cutover toggle: one env read at construction, a full decision object out, default ON. |
| `domain-events.module.ts` | The composition: `@Global()` bindings, the empty subscriber array, and the "closed ⇒ do not bind the bus at all" path. |
| `domain-event-bus.typecheck.ts` | The self-invalidating fixture that proves the guard below still bites. |

The event catalog itself lives in `packages/contracts/src/domain-event.ts` — one
declaration of the five event names, their envelope, and their payloads, with
the in-band statement of what these events are (in-process, synchronous, not
persisted) and the condition that would upgrade one into an integration event.

## The non-event admission rule

> **A collaboration that requires an acknowledgement, that can be refused, or
> whose result the publisher depends on is a CALL, not an EVENT.**

That is the whole test, and it is deliberately phrased in terms of return and
acknowledgement semantics rather than in terms of which concern is involved.
"Auditing is cross-cutting, therefore auditing is an event" is not an argument —
whether a particular audit collaboration is an event depends on whether its
caller needs to hear back, and in this codebase one audit collaboration does and
another does not.

An event states that something already happened. Its publisher has already
committed and cannot be talked out of it, so the only thing a subscriber can do
with an event is ignore it. The moment a publisher branches on what a
collaborator answered — or would have to retry, or hold a lifecycle transition
open until the answer arrived — the collaboration is a command with an event's
clothes on, and moving it onto the bus converts a checked dependency into an
unchecked one.

**The rule is enforced by the compiler, not by review.** The handler position on
`DomainEventBusPort.subscribe` (and on `defineDomainEventSubscriber`, which is
how the `DOMAIN_EVENT_SUBSCRIBERS` array is built) rejects every handler whose
return type is not `void`, and the rejection type spells the rule out so the
compiler prints it at the offending call site. `domain-event-bus.typecheck.ts`
pins this with `@ts-expect-error`: weaken the guard and the now-unused
directives fail the build with TS2578, so the guard cannot be quietly removed.

The audit-durability tier names `batch` and `blocking-strict` are defined
normatively in the `domain-event-bus` capability spec
(`openspec/specs/domain-event-bus/spec.md`) — the single place that defines them.
This file references the names; it does not restate the definitions.

### Worked examples, not exceptions

These three collaborations in today's codebase are calls under the rule above.
They are listed as worked examples of the criterion — not as three special cases
carved out of it, and not as a closed list. Apply the criterion to the fourth
one; do not look for it here.

1. **Terminal provisioning audit detail** — `AuditRecorderPort.recordProvisioningFailure`
   and `recordTaskCancellation` return `Promise<boolean>`
   (`apps/api/src/audit/audit-recorder.port.ts`). The caller keeps terminal
   admission work reclaimable until that boolean confirms the durable rows
   landed, so recovery can retry the audit boundary. The publisher depends on
   the result — a CALL. (Note that the *ordinary* lifecycle recorders on the
   same port return `Promise<void>` and are best-effort; the port is not
   uniformly one or the other, which is exactly why the criterion is about
   return semantics and not about the word "audit".)

2. **Admission-work lease transitions** — `TaskAdmissionLeaseControls.authorize()`
   and `checkpoint(stage)` (`apps/api/src/admission-coordination/task-admission.types.ts`)
   are awaited for authority: `authorize()` asserts lease ownership, DB-clock
   validity, and the current task fence, and provisioning must not take its next
   step until it has. It can refuse — it throws `TaskAdmissionLeaseLostError` —
   and refusing is its purpose. A CALL.

3. **Provisioning diagnostics write gate** — `TaskProvisioningDiagnosticsWriteGatePort.isEnabled(): boolean`
   (`apps/api/src/task-provisioning-diagnostics/task-provisioning-diagnostics-write-gate.port.ts`).
   The caller branches on the answer before doing the work. A CALL.

### The declared escape hatch for I/O

A subscriber that must do I/O is not thereby a call. It starts the work inside a
`void`-returning method that owns its own `.catch(...)` and never hands the
promise back to the bus:

```ts
onSettled(event: DomainEvent): void {
  void this.archive(event).catch((error: unknown) => this.logger.warn(...));
}
```

`publish` returns without awaiting that work — which is the point: the
publisher's lifecycle transition is not held open by a subscriber's I/O, and a
failure inside it cannot surface as an `unhandledRejection`. This hatch is part
of the contract (it is a positive case in both the capability spec and the
typecheck fixture), so a later change may not remove it on the grounds that the
guard "blocks legitimate use".

## Failure semantics, in one place

- A subscriber that throws is isolated: later subscribers still run, and the
  publisher sees nothing. Exactly one structured warn record is emitted naming
  the event type, the subscriber, and the error message. Silence is not an
  accepted outcome — the phase-4 subscribers include billing-adjacent work.
- A payload that fails catalog validation is dropped before any subscriber runs,
  logged once, and never thrown back at the publisher.
- `'error'` is not, and may not become, an event type: on Node's `EventEmitter`
  semantics that one name turns a swallowed subscriber failure into a
  process-level throw. The bus does not use `EventEmitter` at all, for the
  separate reason that a throwing listener there both skips the listeners after
  it and re-throws out of `emit()`.
