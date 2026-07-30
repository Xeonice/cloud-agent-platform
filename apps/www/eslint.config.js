import config from "@cap-console/eslint-config";

/**
 * Consume the shared monorepo flat config (same as apps/web, apps/api) so
 * `@cap-console/www` passes the repo CI lint gate with the workspace's single ESLint
 * contract. The shared config already ignores Next's build output directory.
 */
export default [
  {
    ignores: ["**/.next/**", "**/out/**", "next-env.d.ts"],
  },
  ...config,
];
