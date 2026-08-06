import { Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  DEFAULT_GUARDRAILS_CONFIG,
  GuardrailsConfig,
  GuardrailsService,
  TRANSCRIPT_SERVICE_TOKEN,
  type ITranscriptCapture,
} from './guardrails.service';
import {
  NOOP_SESSION_TRANSCRIPT_CAPTURE,
  SESSION_TRANSCRIPT_CAPTURE,
  type SessionTranscriptCapturePort,
} from '@/session-transcripts/session-transcript.port';
import { PrismaService } from '@/prisma/prisma.service';
import { RetentionCleaner } from './retention-cleaner';
import {
  SANDBOX_RETENTION_STORE,
} from './sandbox-retention-store';
import { createConfiguredSandboxRetentionStore } from '@cap-console/sandbox';
import { SessionCredentialsService } from '@/creds/session-credentials.service';
import { SANDBOX_PROVIDER, type SandboxProvider } from '@/sandbox/sandbox-provider.port';
import { PROVISION_LOOKUP, type ProvisionLookup } from '@/provision-lookup/provision-lookup.port';
import {
  AUDIT_RECORDER_TOKEN,
  type AuditRecorderPort,
} from '@/audit/audit-recorder.port';
import {
  TASK_PROVISIONING_DIAGNOSTIC_RECORDER,
  type TaskProvisioningDiagnosticRecorderPort,
} from '@/task-provisioning-diagnostics/task-provisioning-diagnostic-recorder.port';
import {
  TASK_PROVISIONING_DIAGNOSTICS_WRITE_GATE,
  type TaskProvisioningDiagnosticsWriteGatePort,
} from '@/task-provisioning-diagnostics/task-provisioning-diagnostics-write-gate.port';
import {
  DOMAIN_EVENT_BUS,
  type DomainEventBusPort,
} from '@/domain-events/domain-event-bus.port';

/**
 * Guardrails module (integration 12.1b).
 *
 * Provides the {@link GuardrailsService}, which composes the semaphore /
 * deadline-watcher / idle-tracker / circuit-breaker and wires their cross-track
 * call sites into the tasks lifecycle and the session-scoped credential teardown.
 *
 * Config (`MAX_CONCURRENT_TASKS`, the OPTIONAL operator-level idle default
 * `MAX_IDLE_MS`, circuit-breaker threshold) is read from the environment at
 * construction, falling back to {@link DEFAULT_GUARDRAILS_CONFIG} (where the idle
 * default is `null` — idle reclamation off unless opted in per task or via
 * `MAX_IDLE_MS`). For the slot ceiling, the env value is only the
 * construction-time SEED (configurable-task-slots): at bootstrap the service
 * loads the persisted `SystemSettings` ceiling (when a row exists) over it via
 * the injected {@link PrismaService}, and a settings save pushes new values at
 * runtime through `GuardrailsService.setMaxConcurrentTasks`. The
 * {@link SandboxProvider} is injected by
 * the global `SANDBOX_PROVIDER` token (9.1b), so the guardrails depend on the
 * port, not a concrete impl.
 */
@Module({
  // collapse-three-collaborator-groups N3: NO imports. The one edge this module
  // had — `forwardRef(() => TasksModule)` — existed solely so the terminal
  // chokepoints could reach the transcript capture service that used to be
  // registered there. The capture owner now lives in its own `@Global()` module,
  // and `TasksService` was never imported here anyway (the orchestrator resolves
  // it lazily by token through `ModuleRef` with `strict: false`).
  imports: [],
  providers: [
    {
      provide: GuardrailsService,
      // TasksService is NOT injected here — GuardrailsService resolves it lazily
      // via ModuleRef in onModuleInit to break the construction cycle. Under the
      // connect-in model there is no per-task TASK_TOKEN, so TaskTokenService is
      // no longer wired (4.4); session-scoped credentials are the sole teardown
      // boundary.
      inject: [
        ModuleRef,
        SessionCredentialsService,
        { token: SANDBOX_PROVIDER, optional: true },
        { token: PROVISION_LOOKUP, optional: true },
        { token: AUDIT_RECORDER_TOKEN, optional: true },
        // PrismaService resolves from the @Global PrismaModule; optional so a
        // guardrails-only unit context still constructs without a database —
        // the bootstrap ceiling load then degrades to the env seed.
        { token: PrismaService, optional: true },
        // collapse-three-collaborator-groups N3 — the durable transcript capture
        // port, NON-optional. The binding below always resolves it: to the real
        // capture owner when its module is composed, to the no-op stand-in when
        // it is not. So the orchestrator receives an implementation either way
        // and no longer branches on a collaborator's presence.
        TRANSCRIPT_SERVICE_TOKEN,
        { token: TASK_PROVISIONING_DIAGNOSTIC_RECORDER, optional: true },
        { token: TASK_PROVISIONING_DIAGNOSTICS_WRITE_GATE, optional: true },
        // add-domain-event-bus 4.2 — THIS provider is a `useFactory` with a
        // POSITIONAL inject array, so the `@Optional()` decorator on the
        // service's 11th constructor parameter does nothing here: Nest resolves
        // what this array lists, in this order, and nothing else. Without this
        // entry (and the matching factory parameter and argument below) the bus
        // would be `undefined` on every production path while every test that
        // constructs the service directly still passed one — publishing would be
        // silently dead and nothing would go red.
        { token: DOMAIN_EVENT_BUS, optional: true },
      ],
      useFactory: (
        moduleRef: ModuleRef,
        creds: SessionCredentialsService,
        sandbox?: SandboxProvider,
        provisionLookup?: ProvisionLookup,
        audit?: AuditRecorderPort,
        prisma?: PrismaService,
        // Always supplied — see the non-optional inject entry above. The `?`
        // survives only because TypeScript forbids a required parameter after
        // an optional one, and the parameters before this are genuinely optional.
        transcripts?: ITranscriptCapture,
        provisioningDiagnosticRecorder?: TaskProvisioningDiagnosticRecorderPort,
        provisioningDiagnosticWriteGate?: TaskProvisioningDiagnosticsWriteGatePort,
        bus?: DomainEventBusPort,
      ) =>
        new GuardrailsService(
          moduleRef,
          creds,
          sandbox,
          readGuardrailsConfig(),
          provisionLookup,
          audit,
          prisma,
          transcripts,
          provisioningDiagnosticRecorder,
          provisioningDiagnosticWriteGate,
          bus,
        ),
    },
    // collapse-three-collaborator-groups N3 — bind the token the orchestrator's
    // capture call site resolves to the capture PORT the transcript context
    // exports, and fall back to the no-op stand-in when no capture provider is
    // composed (a guardrails-only unit context, say). This is what makes the
    // injection above non-optional without making the transcript module a hard
    // dependency: the orchestrator always gets an implementation, so it has no
    // presence to branch on, and an unwired deployment captures nothing instead
    // of crashing. The port lookup is optional HERE — exactly one place — rather
    // than at every call site, which was the shape being removed.
    {
      provide: TRANSCRIPT_SERVICE_TOKEN,
      inject: [{ token: SESSION_TRANSCRIPT_CAPTURE, optional: true }],
      useFactory: (
        capture?: SessionTranscriptCapturePort,
      ): SessionTranscriptCapturePort =>
        capture ?? NOOP_SESSION_TRANSCRIPT_CAPTURE,
    },
    {
      provide: SANDBOX_RETENTION_STORE,
      useFactory: () => createConfiguredSandboxRetentionStore(),
    },
    // Retention cleaner: a self-starting unref'd sweeper that applies API
    // retention windows and disk-pressure policy over provider-reported retained
    // sandbox artifacts. Concrete artifact listing/removal is supplied by the
    // sandbox harness. PrismaService (for the retention window) resolves from the
    // @Global PrismaModule, optional so a guardrails unit context still
    // constructs without a database (window → default).
    RetentionCleaner,
  ],
  exports: [GuardrailsService],
})
export class GuardrailsModule {}

/** Reads guardrail tunables from the environment, with sane fallbacks. */
function readGuardrailsConfig(): GuardrailsConfig {
  return {
    maxConcurrentTasks: readPositiveInt(
      process.env.MAX_CONCURRENT_TASKS,
      DEFAULT_GUARDRAILS_CONFIG.maxConcurrentTasks,
    ),
    // OPTIONAL operator-level idle default: a positive `MAX_IDLE_MS` becomes the
    // global default ceiling for tasks without a per-task `idleTimeoutMs`; unset
    // (or invalid) leaves it `null` so idle reclamation is OFF by default.
    defaultIdleTimeoutMs: readOptionalPositiveInt(
      process.env.MAX_IDLE_MS,
      DEFAULT_GUARDRAILS_CONFIG.defaultIdleTimeoutMs,
    ),
    circuitBreakerThreshold: readPositiveInt(
      process.env.CIRCUIT_BREAKER_THRESHOLD,
      DEFAULT_GUARDRAILS_CONFIG.circuitBreakerThreshold,
    ),
    cleanupTerminalPolicyMaxAttempts: readPositiveInt(
      process.env.SANDBOX_CLEANUP_TERMINAL_POLICY_MAX_ATTEMPTS,
      DEFAULT_GUARDRAILS_CONFIG.cleanupTerminalPolicyMaxAttempts!,
    ),
  };
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Like {@link readPositiveInt} but null-aware: a valid positive integer env value
 * is used; otherwise the (possibly `null`) fallback is returned unchanged, so an
 * unset/invalid `MAX_IDLE_MS` leaves idle reclamation off by default.
 */
function readOptionalPositiveInt(
  raw: string | undefined,
  fallback: number | null,
): number | null {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
