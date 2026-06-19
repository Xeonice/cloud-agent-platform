import { Controller, Get, Header } from '@nestjs/common';
import {
  buildV1OpenApiDocument,
  buildV1DocsHtml,
  type OpenApiDocument,
} from './openapi.registry';

/**
 * Public OpenAPI surface for `/v1` (public-v1-api, Track `openapi`, task 4.2).
 *
 * Serves two UNAUTHENTICATED endpoints — both exempted in `auth.guard.ts`
 * (task 4.3), exactly like `/version`, because they expose only read-only API
 * metadata and carry NO secrets:
 *
 *   - `GET /v1/openapi.json` — the OpenAPI 3.1 document, generated from the
 *     `@cap/contracts` zod schemas the `/v1` controllers validate against, so
 *     the spec cannot drift from the wire (D3). Covers every `/v1` route.
 *   - `GET /v1/docs` — an interactive Swagger UI page pointed at the spec above.
 *
 * The controller is a thin serializer: all generation lives in
 * {@link buildV1OpenApiDocument} / {@link buildV1DocsHtml} so it is pure and
 * testable. The OpenApiModule that registers this controller into the app is
 * assembled by the Integration track (4.1).
 */
@Controller('v1')
export class OpenApiController {
  /**
   * The OpenAPI 3.1 document for the `/v1` surface. Regenerated per request from
   * the registered schemas (cheap; keeps the response always in sync with the
   * contracts in-process). Reachable without an operator credential.
   */
  @Get('openapi.json')
  @Header('Content-Type', 'application/json')
  openapi(): OpenApiDocument {
    return buildV1OpenApiDocument();
  }

  /**
   * Interactive Swagger UI page rendering the `/v1` spec. Reachable without an
   * operator credential.
   */
  @Get('docs')
  @Header('Content-Type', 'text/html; charset=utf-8')
  docs(): string {
    return buildV1DocsHtml();
  }
}
