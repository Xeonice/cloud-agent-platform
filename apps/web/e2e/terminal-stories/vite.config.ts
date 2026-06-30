import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

const storyRoot = fileURLToPath(new URL(".", import.meta.url));
const webRoot = resolve(storyRoot, "../..");

export default defineConfig({
  root: storyRoot,
  publicDir: resolve(webRoot, "public"),
  server: {
    host: "127.0.0.1",
    port: 4327,
    strictPort: true,
  },
  plugins: [tailwindcss(), react()],
});
