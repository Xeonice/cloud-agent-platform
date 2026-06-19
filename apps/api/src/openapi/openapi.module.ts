import { Module } from '@nestjs/common';
import { OpenApiController } from './openapi.controller';

/**
 * The public `/v1` OpenAPI surface module (public-v1-api, Integration task 4.1).
 *
 * Registers the {@link OpenApiController}, which serves the two UNAUTHENTICATED
 * docs endpoints (`GET /v1/openapi.json` + `GET /v1/docs`, exempted in
 * `auth.guard.ts` exactly like `/version`). The document is generated on demand
 * from the `@cap/contracts` `/v1` schemas the controllers validate against, so it
 * cannot drift from the wire (design D3).
 *
 * The once-per-process `extendZodWithOpenApi(z)` init on the shared
 * `@cap/contracts` z instance is owned by Integration and lives in `main.ts`
 * (called before the app starts handling requests); the registry also calls it
 * defensively/idempotently so this module is generatable in isolation.
 */
@Module({
  controllers: [OpenApiController],
})
export class OpenApiModule {}
