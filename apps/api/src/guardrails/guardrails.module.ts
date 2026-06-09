import { forwardRef, Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { TasksModule } from '../tasks/tasks.module';
import {
  DEFAULT_GUARDRAILS_CONFIG,
  GuardrailsConfig,
  GuardrailsService,
} from './guardrails.service';
import { SessionCredentialsService } from '../creds/session-credentials.service';
import { SANDBOX_PROVIDER, type SandboxProvider } from '../sandbox/sandbox-provider.port';
import {
  AUDIT_RECORDER_TOKEN,
  type AuditRecorderPort,
} from '../audit/audit-recorder.port';

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
 * `MAX_IDLE_MS`). The {@link SandboxProvider} is injected by
 * the global `SANDBOX_PROVIDER` token (9.1b), so the guardrails depend on the
 * port, not a concrete impl.
 */
@Module({
  imports: [forwardRef(() => TasksModule)],
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
        { token: AUDIT_RECORDER_TOKEN, optional: true },
      ],
      useFactory: (
        moduleRef: ModuleRef,
        creds: SessionCredentialsService,
        sandbox?: SandboxProvider,
        audit?: AuditRecorderPort,
      ) =>
        new GuardrailsService(
          moduleRef,
          creds,
          sandbox,
          readGuardrailsConfig(),
          audit,
        ),
    },
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
