import config from "@cap-console/eslint-config";
import { boundaryConfigs } from "@cap-console/eslint-config/boundaries";

/**
 * Pilot wiring for the manifest-derived boundary rules (design D9: prove one
 * config end to end before fanning out to the other eslint.config.* files).
 * `packageDir` is this package's identity — the factory emits only the rules
 * `docs/refactor/boundaries-manifest.json` scopes to apps/web.
 */
export default [...config, ...boundaryConfigs({ packageDir: import.meta.dirname })];
