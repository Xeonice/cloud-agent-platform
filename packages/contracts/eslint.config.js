import config from "@cap-console/eslint-config";
import { boundaryConfigs } from "@cap-console/eslint-config/boundaries";

/**
 * `packageDir` is this package's identity: the factory emits only the rules
 * `docs/refactor/boundaries-manifest.json` scopes to this package. It is passed
 * explicitly rather than inferred from `process.cwd()`, because an editor
 * running ESLint from the repository root would then get a different — and
 * silently smaller — rule set than CI.
 */
export default [...config, ...boundaryConfigs({ packageDir: import.meta.dirname })];
