import config from "@cap-console/eslint-config";
import { boundaryConfigs } from "@cap-console/eslint-config/boundaries";

/**
 * Consume the shared monorepo flat config (same as apps/web, apps/api) so
 * `@cap-console/www` passes the repo CI lint gate with the workspace's single ESLint
 * contract. The shared config already ignores Next's build output directory.
 *
 * `packageDir` is this package's identity: the factory emits only the rules
 * `docs/refactor/boundaries-manifest.json` scopes to this package — here P8,
 * "zero runtime dependency on the console or the backend". It is passed
 * explicitly rather than inferred from `process.cwd()`, because an editor
 * running ESLint from the repository root would then get a different — and
 * silently smaller — rule set than CI.
 */
export default [
  {
    ignores: ["**/.next/**", "**/out/**", "next-env.d.ts"],
  },
  ...config,
  ...boundaryConfigs({ packageDir: import.meta.dirname }),
];
