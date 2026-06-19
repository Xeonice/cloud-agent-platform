import { z } from 'zod';

/**
 * The EXACT `zod` instance every `@cap/contracts` schema is built on.
 *
 * Why this is re-exported (public-v1-api, Integration 4.1):
 *
 * `@cap/contracts` is an ESM package (`"type": "module"` → its built schemas
 * `import { z } from 'zod'`, resolving zod's ESM entry `index.js`). A CJS consumer
 * (e.g. `@cap/api`, `"type": "commonjs"`) that does `require('zod')` resolves zod's
 * SEPARATE CJS entry `index.cjs` — a DISTINCT class realm whose `ZodType`/`ZodObject`
 * are NOT the prototypes the contracts schemas inherit from. So a prototype-level
 * augmentation like `extendZodWithOpenApi(z)` applied to the CJS `z` never reaches
 * the ESM-built contract schema instances (`schema.openapi` stays undefined), and
 * OpenAPI generation over those schemas throws `schema.openapi is not a function`.
 *
 * Re-exporting the instance the schemas actually use lets the OpenAPI integration
 * call `extendZodWithOpenApi(contractsZ)` ONCE on the right realm, making the spec
 * "extend the shared `@cap/contracts` z instance" literally true rather than
 * extending a parallel copy. Consumers MUST augment THIS `z`, not their own
 * `import/require('zod')`, for `.openapi(...)` to be present on every contract DTO.
 */
export { z };
export const contractsZod = z;
