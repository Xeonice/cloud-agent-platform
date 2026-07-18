import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { buildLoggerOptions } from './observability/logger.options';
import { PrismaModule } from './prisma/prisma.module';
import { ReposModule } from './repos/repos.module';
import { TasksModule } from './tasks/tasks.module';
import { TerminalModule } from './terminal/terminal.module';
import { WriteLockModule } from './write-lock/write-lock.module';
import { CredsModule } from './creds/creds.module';
import { SandboxModule } from './sandbox/sandbox.module';
import { GuardrailsModule } from './guardrails/guardrails.module';
import { MetricsModule } from './metrics/metrics.module';
import { UpdateStatusModule } from './update-status/update-status.module';
import { SelfUpdateModule } from './self-update/self-update.module';
import { RuntimesModule } from './runtimes/runtimes.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { AuditModule } from './audit/audit.module';
import { SettingsModule } from './settings/settings.module';
import { ForgeModule } from './forge/forge.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { McpTokensModule } from './mcp-tokens/mcp-tokens.module';
import { McpModule } from './mcp/mcp.module';
import { V1Module } from './v1/v1.module';
import { OpenApiModule } from './openapi/openapi.module';
import { PrincipalThrottlerGuard } from './rate-limit/principal.throttler-guard';
import { CreateThrottleGuard } from './rate-limit/create-throttle.guard';
import { AuthThrottleGuard } from './rate-limit/auth-throttle.guard';
import { RuntimeModelCatalogThrottleGuard } from './rate-limit/runtime-model-catalog-throttle.guard';
import { buildThrottlerOptions } from './rate-limit/throttler.options';
import { MailModule } from './mail/mail.module';
import { OtpModule } from './auth-otp/otp.module';
import { AccountsModule } from './accounts/accounts.module';
import { AdminSeedModule } from './admin-seed/admin-seed.module';
import { PasswordModule } from './auth-password/password.module';
import { SmtpEnvMigrationModule } from './mail/smtp-env-migration.module';
import { SandboxEnvironmentsModule } from './sandbox-environments/sandbox-environments.module';
import { ScheduledTasksModule } from './scheduled-tasks/scheduled-tasks.module';
import { RuntimeModelsModule } from './runtime-models/runtime-models.module';
import { TaskProvisioningDiagnosticsModule } from './task-provisioning-diagnostics/task-provisioning-diagnostics.module';

/**
 * Root application module.
 *
 * Composes the full orchestrator after integration:
 *  - data plane: `PrismaModule`, `ReposModule`, `TasksModule`;
 *  - realtime: `TerminalModule` (dual-channel gateway with connect-auth 11.4,
 *    keystroke gating 7.5, and approval routing 6.5 — the latter re-homed onto
 *    the `/internal/sandbox/approvals` HTTP callback under connect-in) + `WriteLockModule`;
 *  - safety: `CredsModule` (global ephemeral session credentials), `SandboxModule`
 *    (the `SandboxProvider` port bound by token, 9.1b), `GuardrailsModule`
 *    (semaphore / deadline / idle / circuit-breaker wired into the lifecycle +
 *    teardown, 12.1b);
 *  - observability: `MetricsModule` exposes the session-gated `GET /metrics`
 *    composing the exact semaphore-derived capacity block with the cached
 *    sampled CPU/memory block (be-metrics 5.1–5.5); `UpdateStatusModule` exposes
 *    the operator-guarded `GET /update-status` (update-availability-check,
 *    Phase 2) — a cached, best-effort GitHub-Release comparison against the
 *    running `CAP_VERSION` that degrades honestly to `updateAvailable: false`.
 *    `SelfUpdateModule` (self-update-action, Phase 3) exposes the admin-gated,
 *    env-gated `POST /self-update` — the one-click host-root upgrade trigger.
 *    Default-OFF (`SELF_UPDATE_ENABLED` unset → the endpoint refuses) so merely
 *    composing it is INERT: no live upgrade capability exists until an operator
 *    deliberately enables it. `RuntimesModule` (add-claude-code-runtime Track 3)
 *    exposes the operator-guarded `GET /runtimes` — per-runtime readiness booleans
 *    (codex always ready; `claude-code` ready iff a Claude OAuth token is
 *    configured), backed by the deployment auth sources and leaking no secret, so
 *    the create dialog can disable an un-configured runtime before task creation;
 *  - auth: `AuthModule` registers the operator-auth guard GLOBALLY on all REST
 *    endpoints (exempting `/health`), 11.2b. The refuse-to-boot check on an unset
 *    `AUTH_TOKEN` (11.3b) and CORS/WS-origin allow-listing (10.1b) live in the
 *    bootstrap (`main.ts`).
 *  - audit/approvals: `AuditModule` (be-audit-approvals 6.2–6.5) is the single
 *    place the recorder is registered. It is `@Global()` and aliases the concrete
 *    `AuditService` under the `AUDIT_RECORDER_TOKEN`, so the lifecycle services
 *    (`TasksService`, `GuardrailsService`) pick up the best-effort recorder by
 *    token (`@Optional()`) WITHOUT importing `AuditModule` — which is what avoids
 *    the cycle `TasksModule -> AuditModule -> TerminalModule -> TasksModule`.
 *  - settings: `SettingsModule` (account-settings 7.2–7.6) exposes the session-
 *    gated `/settings*` surface, the per-account-scoped preferences + the
 *    AES-256-GCM-encrypted-at-rest compatible-provider Codex credential, and the
 *    candidate model-discovery boundary.
 *  - api-keys: `ApiKeysModule` (api-key-machine-identity, tasks 5.1/5.2) exposes
 *    the session-gated `/api-keys*` surface — mint (raw `cap_sk_…` shown once,
 *    hash-only at rest), list (non-secret metadata), revoke (idempotent). Every
 *    route is session-ONLY (a machine credential is 403'd), so a key cannot mint
 *    another key. Composing it is the live target of the CI boot-smoke (Track 1).
 *  - public API: `V1Module` (public-v1-api, Integration 3.6) assembles the
 *    additive `/v1` REST + SSE surface (task/repo/transcript controllers + the
 *    lifecycle-event SSE controller), delegating to the SAME services the console
 *    uses (one task-admission path). `OpenApiModule` (Integration 4.1) serves the
 *    unauthenticated `GET /v1/openapi.json` + `GET /v1/docs` generated from the
 *    `@cap/contracts` `/v1` schemas, so the published spec cannot drift from the
 *    wire. Both are imported AFTER `AuthModule` so the global auth guard already
 *    protects the `/v1` data surface (only the exact-match docs/spec paths are
 *    exempt in `auth.guard.ts`).
 *  - rate limiting: `ThrottlerModule.forRoot(buildThrottlerOptions())` registers
 *    the in-memory, env-overridable `default` (per-request), `create` (the stricter
 *    `POST /v1/tasks` cap the v1-tasks `@Throttle({ create })` references), and
 *    `auth` (anonymous pre-auth) throttlers. Each tier is enforced by ITS OWN global
 *    `APP_GUARD`, narrowed to that single tier in `onModuleInit`, so no request is
 *    double-counted: {@link PrincipalThrottlerGuard} enforces `default` only,
 *    {@link CreateThrottleGuard} enforces `create` only (and ONLY on `POST /v1/tasks`
 *    — so the small create cap never lands on general authenticated polling), and
 *    {@link AuthThrottleGuard} enforces `auth` only (and ONLY on the pre-auth
 *    routes). The two principal-keyed guards are listed in `providers` AFTER
 *    `AuthModule` (whose own `APP_GUARD` is the auth guard) appears in `imports`, so
 *    they run AFTER auth and key their bucket on the resolved `req.operatorPrincipal`
 *    (per-api-key id / per-user id) rather than the client IP (design D7).
 */
@Module({
  imports: [
    // structured-logging: pino-backed JSON stdout logging + reqId/taskId
    // correlation + secret redaction. First so it backs every other module's
    // Logger; main.ts promotes it to the app logger via `useLogger`.
    LoggerModule.forRoot(buildLoggerOptions()),
    PrismaModule,
    TaskProvisioningDiagnosticsModule,
    CredsModule,
    SandboxModule,
    SandboxEnvironmentsModule,
    RuntimeModelsModule,
    ScheduledTasksModule,
    HealthModule,
    ReposModule,
    TasksModule,
    WriteLockModule,
    TerminalModule,
    GuardrailsModule,
    MetricsModule,
    UpdateStatusModule,
    SelfUpdateModule,
    RuntimesModule,
    // AuthModule registers the GLOBAL auth guard (the FIRST APP_GUARD). It is
    // imported BEFORE the throttler guard is provided below so the two global
    // guards run auth-then-throttle (the throttler keys on the post-auth
    // principal). 6.1.
    AuthModule,
    AuditModule,
    SettingsModule,
    ForgeModule,
    ApiKeysModule,
    // add-private-account-identity (integration task 10.1): the new private-
    // identity feature modules, wired here in the ROOT module — the single
    // `app.module.ts` edit every parallel auth track deferred to integration, so
    // the module graph is assembled (and proven cycle-free) in ONE place. All are
    // imported AFTER `AuthModule` so the global auth guard already governs their
    // REST surface; the new PUBLIC pre-auth routes they expose
    // (`/auth/otp/*`, `/auth/admin/reveal`, …) are EXACT-MATCH exempted in
    // `auth.guard.ts` (task 2.6) and brute-force throttled by the `auth` tier
    // (the third global guard below):
    //   - `MailModule`     — the single `nodemailer`/SMTP send path; EXPORTS
    //     `MailService` so `OtpModule` both sends codes and reads the
    //     `isConfigured()` capability that fail-closes OTP when SMTP is unset.
    //   - `OtpModule`      — `/auth/otp/request` + `/auth/otp/verify`
    //     (email-verification-code login; imports `MailModule`).
    //   - `AccountsModule` — admin-only `/accounts*` CRUD/list (session-gated by
    //     the global guard, then admin-role re-confirmed in the controller).
    //   - `AdminSeedModule`— the self-contained, order-independent default-admin
    //     seed (its OWN single `onApplicationBootstrap` hook + in-memory reveal
    //     holder, NOT spread across providers, per the prior cross-bootstrap
    //     outage) + `POST /auth/admin/reveal` one-time reveal.
    //   - `PasswordModule` — `/auth/password` (email+password login) +
    //     `/auth/change-password` (forced first-login + self-service change). Both
    //     paths are exact-match members of the guard's `PUBLIC_AUTH_PATHS` and the
    //     `auth` IP+email throttle tier, so they are governed pre-auth.
    MailModule,
    OtpModule,
    AccountsModule,
    AdminSeedModule,
    PasswordModule,
    // add-smtp-config-ui (backend-storage task 2.3): the self-contained,
    // order-independent one-time env→DB SMTP migration boot seed (its OWN single
    // `onApplicationBootstrap` hook in its OWN module, NOT spread across other
    // providers, per the prior cross-bootstrap outage — exactly mirroring
    // `AdminSeedModule`). On first boot with the env `SMTP_*` configured, no DB
    // config present, and an encryption key available, it copies the env SMTP
    // into the singleton DB config (encrypting the password) and stamps the
    // marker so it never re-seeds; no key ⇒ skip (env fallback continues). It
    // never throws into boot.
    SmtpEnvMigrationModule,
    // remote-mcp-server (integration, task 7.2): the two new feature modules,
    // wired here in the ROOT module — the one `app.module.ts` edit both backend
    // feature tracks would otherwise both touch, so it is isolated to the
    // serialized integration step. `McpTokensModule` (Track 3) owns the
    // session-minted `mcp_` credential lifecycle (`/mcp-tokens` CRUD +
    // `resolveMcpToken` reached through `AuthSessionService`); `McpModule`
    // (Track 4) owns the `/mcp` StreamableHTTP endpoint + the six tools, gated on
    // `SystemSettings.mcpServerEnabled` (default false → inert) and bearer-checked
    // by the `requireBearerAuth` middleware mounted in `main.ts`. Both are imported
    // AFTER `AuthModule` so the global auth guard already governs the REST surface
    // (the guard EXACT-MATCH exempts `/mcp`, which `requireBearerAuth` gates
    // downstream). The settings `mcpServerEnabled` toggle (Track 5) lives inside
    // the already-registered `SettingsModule`, so it needs no AppModule edit.
    McpTokensModule,
    McpModule,
    // public-v1-api: the versioned `/v1` data/SSE surface + its OpenAPI docs.
    // After AuthModule so the global auth guard already covers the data routes.
    V1Module,
    OpenApiModule,
    // public-v1-api 6.1: in-memory, env-overridable named throttlers — `default`
    // (the global per-request cap) + `create` (the stricter POST /v1/tasks cap
    // referenced by the v1-tasks `@Throttle({ create })`).
    ThrottlerModule.forRoot(buildThrottlerOptions()),
  ],
  providers: [
    // public-v1-api 6.1: the SECOND global guard. Provided here (not inside a
    // feature module) and AFTER AuthModule is imported, so global-guard order is
    // auth-then-throttle — the throttler reads the principal the auth guard
    // attached and keys the rate bucket per-principal, not per-IP (design D7).
    // It narrows `this.throttlers` to the `default` tier ALONE (in its
    // `onModuleInit`) so it enforces ONLY the per-principal per-request cap —
    // leaving the stricter `create` tier to `CreateThrottleGuard` and the anonymous
    // `auth` tier to `AuthThrottleGuard` below.
    {
      provide: APP_GUARD,
      useClass: PrincipalThrottlerGuard,
    },
    // fix: the dedicated `create`-tier guard. Provided alongside the principal
    // guard, it narrows `this.throttlers` to the `create` tier ALONE and applies it
    // ONLY to `POST /v1/tasks` (every other request is skipped). This is the
    // root-cause fix for the production 429s: the `create` cap (10/60s) used to be
    // retained by the principal guard and charged against EVERY authenticated
    // request (dashboard polling of `/auth/session`, `/metrics`, `/tasks`, …),
    // tripping spurious 429s. It is per-principal (shares `principalTrackerKey`) and
    // DISJOINT from the other two throttler guards, so no request is double-counted.
    {
      provide: APP_GUARD,
      useClass: CreateThrottleGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RuntimeModelCatalogThrottleGuard,
    },
    // add-private-account-identity (integration task 10.1 / track rate-limit-auth):
    // the THIRD global guard — the anonymous pre-auth brute-force throttler. It
    // enforces ONLY the `auth` tier (filtered IN in its `onModuleInit`) and ONLY
    // on the public pre-auth endpoints (`/auth/password`, `/auth/otp/request`,
    // `/auth/otp/verify`, `/auth/change-password` — every other route is skipped),
    // keying the bucket on client IP + submitted email because no principal exists
    // pre-auth (design D10). It is DISJOINT from the principal guard above (that
    // one keeps everything-but-`auth`; this one keeps `auth`-only), so the two
    // never double-count a request and the tiny anonymous cap never lands on
    // authenticated traffic.
    {
      provide: APP_GUARD,
      useClass: AuthThrottleGuard,
    },
  ],
})
export class AppModule {}
