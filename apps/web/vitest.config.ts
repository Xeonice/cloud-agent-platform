/**
 * Minimal Vitest config for the console's verification suite
 * (rebuild-console-tanstack-start task 10.8).
 *
 * Deliberately does NOT load the `tanstackStart()` / `nitro()` Vite plugins —
 * those rewrite the module graph for SSR/router codegen and break a plain test
 * run. The only plugin needed is `tsconfig-paths` so the `@/...` alias resolves
 * exactly as it does in the app build (kept in lockstep with tsconfig `paths`).
 *
 * The suite is pure-logic (capability seam, mock-contract validation, the
 * `filterItems` derivation, store normalization) so it runs in the `node`
 * environment — no DOM, no React render, no `window`. SSR-safety of the modules
 * under test is therefore also implicitly exercised (they must import without a
 * `window`).
 *
 * `.test.tsx` is also collected so a component's STATIC render can be asserted
 * via `react-dom/server` `renderToStaticMarkup` — which needs no DOM/`window`,
 * so it stays in the same node environment (e.g. the transcript `TxRow` render
 * off a `SessionTurn` fixture).
 */
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
