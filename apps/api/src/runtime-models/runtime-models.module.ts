import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { SandboxEnvironmentsModule } from '../sandbox-environments/sandbox-environments.module';
import { SandboxEnvironmentsService } from '../sandbox-environments/sandbox-environments.service';
import { ModelDiscoveryClient } from '../settings/model-discovery.client';
import {
  SANDBOX_ENVIRONMENT_VALIDATION_RUNNER,
  type SandboxEnvironmentValidationRunner,
} from '../sandbox-environments/sandbox-environments.validator';
import {
  RUNTIME_MODEL_CATALOG_ADAPTERS,
  RUNTIME_MODEL_CREDENTIAL_RESOLVER,
  RUNTIME_MODEL_DEPLOYMENT_ENVIRONMENT_RESOLVER,
  RUNTIME_MODEL_ENVIRONMENT_RESOLVER,
  RUNTIME_MODEL_MANAGED_PROVIDER_RESOLVER,
  RUNTIME_MODEL_POLICY_RESOLVER,
  RuntimeModelAdapterRegistry,
  type RuntimeModelCredentialResolver,
  type RuntimeModelDeploymentEnvironmentResolver,
  type RuntimeModelEnvironmentResolver,
  type RuntimeModelManagedProviderResolver,
  type RuntimeModelPolicyResolver,
} from './runtime-model-catalog.port';
import { RuntimeModelCatalogCache } from './runtime-model-catalog-cache';
import { RuntimeModelCatalogService } from './runtime-model-catalog.service';
import { DefaultRuntimeModelPolicyResolver } from './default-runtime-model-policy.resolver';
import { OwnerFairProbeScheduler } from './owner-fair-probe-scheduler';
import { PrismaRuntimeModelCredentialResolver } from './prisma-runtime-model-credential.resolver';
import {
  ConfiguredDeploymentRuntimeModelEnvironmentResolver,
  ConfiguredManagedRuntimeModelProviderResolver,
  DefaultRuntimeModelEnvironmentResolver,
} from './runtime-model-environment.resolver';
import type {
  ResolvedRuntimeModelCatalog,
  ResolvedRuntimeModelEnvironment,
  RuntimeModelAdapterDescriptor,
} from './runtime-model-catalog.types';
import { RuntimeModelPreflightService } from './runtime-model-preflight.service';
import { TaskModelCapabilityService } from './task-model-capability.service';
import { RuntimeModelHttpExceptionFilter } from './runtime-model-http.filter';
import { TaskModelCapabilityController } from './task-model-capability.controller';
import {
  RUNTIME_MODEL_TASKLESS_PROBE,
  type RuntimeModelTasklessProbeLifecycle,
} from './runtime-model-probe.port';
import { ConfiguredRuntimeModelTasklessProbeLifecycle } from './configured-runtime-model-taskless-probe';
import { CodexOfficialModelAdapter } from './codex-official-model.adapter';
import { CodexCompatibleModelAdapter } from './codex-compatible-model.adapter';
import { ClaudeSubscriptionModelAdapter } from './claude-subscription-model.adapter';

const RUNTIME_MODEL_ADAPTER_REGISTRY = Symbol('RuntimeModelAdapterRegistry');
const RUNTIME_MODEL_CATALOG_CACHE = Symbol('RuntimeModelCatalogCache');
const RUNTIME_MODEL_PROBE_SCHEDULER = Symbol('RuntimeModelProbeScheduler');
const RUNTIME_MODEL_DEPLOYMENT_ENVIRONMENT_CACHE = Symbol(
  'RuntimeModelDeploymentEnvironmentCache',
);

/** Shared singleton leaf module for Console, V1, MCP and scheduler model flows. */
@Global()
@Module({
  imports: [SandboxEnvironmentsModule],
  controllers: [TaskModelCapabilityController],
  providers: [
    TaskModelCapabilityService,
    ModelDiscoveryClient,
    // The production lifecycle accepts an optional construction-options object
    // for direct tests. Register it through a zero-argument factory so Nest does
    // not reflect that TypeScript interface as an injectable `Object` token.
    {
      provide: ConfiguredRuntimeModelTasklessProbeLifecycle,
      useFactory: () => new ConfiguredRuntimeModelTasklessProbeLifecycle(),
    },
    {
      provide: RUNTIME_MODEL_TASKLESS_PROBE,
      useExisting: ConfiguredRuntimeModelTasklessProbeLifecycle,
    },
    {
      provide: APP_FILTER,
      useClass: RuntimeModelHttpExceptionFilter,
    },
    {
      provide: RUNTIME_MODEL_CATALOG_ADAPTERS,
      useFactory: (
        lifecycle: RuntimeModelTasklessProbeLifecycle,
        discovery: ModelDiscoveryClient,
      ) =>
        [
          new CodexOfficialModelAdapter(lifecycle),
          new CodexCompatibleModelAdapter(discovery),
          new ClaudeSubscriptionModelAdapter(),
        ] satisfies readonly RuntimeModelAdapterDescriptor[],
      inject: [RUNTIME_MODEL_TASKLESS_PROBE, ModelDiscoveryClient],
    },
    {
      provide: RUNTIME_MODEL_ADAPTER_REGISTRY,
      useFactory: (adapters: readonly RuntimeModelAdapterDescriptor[]) =>
        new RuntimeModelAdapterRegistry(adapters),
      inject: [RUNTIME_MODEL_CATALOG_ADAPTERS],
    },
    {
      provide: RUNTIME_MODEL_CREDENTIAL_RESOLVER,
      useFactory: (prisma: PrismaService) =>
        new PrismaRuntimeModelCredentialResolver(prisma),
      inject: [PrismaService],
    },
    {
      provide: RUNTIME_MODEL_POLICY_RESOLVER,
      useFactory: () => new DefaultRuntimeModelPolicyResolver(),
    },
    {
      provide: RUNTIME_MODEL_MANAGED_PROVIDER_RESOLVER,
      useFactory: () => new ConfiguredManagedRuntimeModelProviderResolver(),
    },
    {
      provide: RUNTIME_MODEL_CATALOG_CACHE,
      useFactory: () => {
        const maxInFlight = positiveEnv(
          'RUNTIME_MODEL_CATALOG_MAX_IN_FLIGHT',
          128,
        );
        const requestedPerOwner = positiveEnv(
          'RUNTIME_MODEL_CATALOG_MAX_IN_FLIGHT_PER_OWNER',
          16,
        );
        return new RuntimeModelCatalogCache<ResolvedRuntimeModelCatalog>({
          ttlMs: positiveEnv('RUNTIME_MODEL_CATALOG_CACHE_TTL_MS', 60_000),
          maxEntries: positiveEnv('RUNTIME_MODEL_CATALOG_CACHE_MAX_ENTRIES', 512),
          maxInFlight,
          maxInFlightPerOwner: Math.min(
            requestedPerOwner,
            maxInFlight === 1 ? 1 : maxInFlight - 1,
          ),
        });
      },
    },
    {
      provide: RUNTIME_MODEL_PROBE_SCHEDULER,
      useFactory: () => {
        const globalConcurrency = positiveEnv(
          'RUNTIME_MODEL_PROBE_GLOBAL_LIMIT',
          8,
        );
        const requestedPerOwner = positiveEnv(
          'RUNTIME_MODEL_PROBE_OWNER_LIMIT',
          2,
        );
        return new OwnerFairProbeScheduler({
          globalConcurrency,
          perOwnerConcurrency: Math.min(
            requestedPerOwner,
            globalConcurrency === 1 ? 1 : globalConcurrency - 1,
          ),
          globalQueueLimit: positiveEnv('RUNTIME_MODEL_PROBE_GLOBAL_QUEUE', 128),
          perOwnerQueueLimit: positiveEnv('RUNTIME_MODEL_PROBE_OWNER_QUEUE', 16),
          queueWaitTimeoutMs: positiveEnv(
            'RUNTIME_MODEL_PROBE_QUEUE_TIMEOUT_MS',
            20_000,
          ),
        });
      },
    },
    {
      provide: RUNTIME_MODEL_DEPLOYMENT_ENVIRONMENT_CACHE,
      useFactory: () => {
        const maxInFlight = positiveEnv(
          'RUNTIME_MODEL_ENVIRONMENT_MAX_IN_FLIGHT',
          32,
        );
        const requestedPerOwner = positiveEnv(
          'RUNTIME_MODEL_ENVIRONMENT_MAX_IN_FLIGHT_PER_OWNER',
          4,
        );
        return new RuntimeModelCatalogCache<ResolvedRuntimeModelEnvironment>({
          ttlMs: positiveEnv('RUNTIME_MODEL_ENVIRONMENT_CACHE_TTL_MS', 300_000),
          maxEntries: positiveEnv('RUNTIME_MODEL_ENVIRONMENT_CACHE_MAX_ENTRIES', 128),
          maxInFlight,
          maxInFlightPerOwner: Math.min(
            requestedPerOwner,
            maxInFlight === 1 ? 1 : maxInFlight - 1,
          ),
        });
      },
    },
    {
      provide: RUNTIME_MODEL_DEPLOYMENT_ENVIRONMENT_RESOLVER,
      useFactory: (
        validationRunner: SandboxEnvironmentValidationRunner,
        cache: RuntimeModelCatalogCache<ResolvedRuntimeModelEnvironment>,
        scheduler: OwnerFairProbeScheduler,
      ) =>
        new ConfiguredDeploymentRuntimeModelEnvironmentResolver({
          validationRunner,
          cache,
          scheduler,
        }),
      inject: [
        SANDBOX_ENVIRONMENT_VALIDATION_RUNNER,
        RUNTIME_MODEL_DEPLOYMENT_ENVIRONMENT_CACHE,
        RUNTIME_MODEL_PROBE_SCHEDULER,
      ],
    },
    {
      provide: RUNTIME_MODEL_ENVIRONMENT_RESOLVER,
      useFactory: (
        prisma: PrismaService,
        environments: SandboxEnvironmentsService,
        managedProviders: RuntimeModelManagedProviderResolver,
        deployment: RuntimeModelDeploymentEnvironmentResolver,
      ) =>
        new DefaultRuntimeModelEnvironmentResolver(
          prisma,
          environments,
          managedProviders,
          deployment,
        ),
      inject: [
        PrismaService,
        SandboxEnvironmentsService,
        RUNTIME_MODEL_MANAGED_PROVIDER_RESOLVER,
        RUNTIME_MODEL_DEPLOYMENT_ENVIRONMENT_RESOLVER,
      ],
    },
    {
      provide: RuntimeModelCatalogService,
      useFactory: (
        environmentResolver: RuntimeModelEnvironmentResolver,
        credentialResolver: RuntimeModelCredentialResolver,
        policyResolver: RuntimeModelPolicyResolver,
        adapters: RuntimeModelAdapterRegistry,
        cache: RuntimeModelCatalogCache<ResolvedRuntimeModelCatalog>,
        scheduler: OwnerFairProbeScheduler,
      ) =>
        new RuntimeModelCatalogService({
          environmentResolver,
          credentialResolver,
          policyResolver,
          adapters,
          cache,
          scheduler,
          requestTimeoutMs: positiveEnv(
            'RUNTIME_MODEL_CATALOG_REQUEST_TIMEOUT_MS',
            30_000,
          ),
        }),
      inject: [
        RUNTIME_MODEL_ENVIRONMENT_RESOLVER,
        RUNTIME_MODEL_CREDENTIAL_RESOLVER,
        RUNTIME_MODEL_POLICY_RESOLVER,
        RUNTIME_MODEL_ADAPTER_REGISTRY,
        RUNTIME_MODEL_CATALOG_CACHE,
        RUNTIME_MODEL_PROBE_SCHEDULER,
      ],
    },
    {
      provide: RuntimeModelPreflightService,
      useFactory: (catalogs: RuntimeModelCatalogService) =>
        new RuntimeModelPreflightService(catalogs),
      inject: [RuntimeModelCatalogService],
    },
  ],
  exports: [
    RuntimeModelCatalogService,
    RuntimeModelPreflightService,
    TaskModelCapabilityService,
  ],
})
export class RuntimeModelsModule {}

function positiveEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
