import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

const storyRoot = fileURLToPath(new URL(".", import.meta.url));
const webRoot = resolve(storyRoot, "../..");

export default defineConfig({
  root: storyRoot,
  publicDir: resolve(webRoot, "public"),
  server: {
    host: "0.0.0.0",
    port: 4331,
    strictPort: true,
  },
  resolve: {
    // The production dialog owns the UI/state machine. The story adapter keeps
    // its same typed fetch boundary without pulling TanStack Start's SSR-only
    // cookie helper into this standalone browser harness.
    alias: {
      "@/lib/api/real": resolve(storyRoot, "src/story-api.ts"),
    },
  },
  plugins: [tsconfigPaths(), tailwindcss(), react()],
});
