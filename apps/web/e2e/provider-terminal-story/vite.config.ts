import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

const storyRoot = fileURLToPath(new URL(".", import.meta.url));
const webRoot = resolve(storyRoot, "../..");

export default defineConfig({
  root: storyRoot,
  publicDir: resolve(webRoot, "public"),
  server: {
    host: "127.0.0.1",
    port: 4328,
    strictPort: true,
  },
  plugins: [tsconfigPaths(), tailwindcss(), react()],
});
