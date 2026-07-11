import { resolve } from "node:path";
import { defineConfig, type UserConfig } from "vite";

import productionConfig from "../../vite.config";

const configuredEnvDir = process.env.E2E_EMPTY_ENV_DIR?.trim();
if (!configuredEnvDir) {
  throw new Error(
    "E2E_EMPTY_ENV_DIR is required so scheduled-task E2E never reads apps/web/.env",
  );
}

const base = productionConfig as UserConfig;

export default defineConfig({
  ...base,
  envDir: resolve(configuredEnvDir),
  server: {
    ...base.server,
    host: "127.0.0.1",
    strictPort: true,
  },
});
