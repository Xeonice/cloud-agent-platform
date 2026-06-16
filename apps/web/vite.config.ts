/**
 * Vite config for the TanStack Start console (rebuild-console-tanstack-start D3).
 *
 * Vinxi is REMOVED in current TanStack Start — this is the Vite-native setup.
 * The plugin order is LOAD-BEARING (wrong order breaks the build); stale
 * Vinxi/`app.config.ts` tutorials online will mislead. The pinned order is:
 *
 *   tailwindcss()  →  tanstackStart({ srcDirectory: 'src' })  →  viteReact()  →  nitro()
 *
 * `nitro()` (from `nitro/vite`) owns the server build; the Vercel deploy target
 * is selected via the Nitro `vercel` preset. The installed nitro
 * (3.0.260603-beta) types the plugin as `nitro(pluginConfig?: NitroPluginConfig)`
 * where `NitroPluginConfig extends NitroConfig`, and `NitroConfig.preset` is a
 * top-level `PresetNameInput` (which includes `"vercel"`) — so the explicit,
 * in-config form is `nitro({ preset: "vercel" })` (there is NO `config` wrapper
 * key in this version). The `NITRO_PRESET` env var still overrides this at build
 * time, so CI can retarget without editing source. The old Next-shaped
 * `vercel.json` is removed. The cross-origin `VITE_API_BASE_URL` / `VITE_WS_URL`
 * contract is preserved so web (Vercel) still targets the api (Fly/compose)
 * origin.
 */
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  server: {
    port: 3000,
  },
  plugins: [
    tsconfigPaths(),
    tailwindcss(),
    tanstackStart({ srcDirectory: "src" }),
    viteReact(),
    // Deploy target is SELECTED at build time via `NITRO_PRESET` (read here
    // explicitly — an in-config literal preset is NOT overridden by the env var
    // in this nitro version, so we must read it ourselves). Default `vercel`
    // keeps the Vercel deploy unchanged with zero Vercel-config edit; the
    // compose web image sets `NITRO_PRESET=node-server` (emits
    // `.output/server/index.mjs`). Verified against nitro 3.0.260603-beta
    // `NitroConfig.preset: PresetNameInput` (includes "vercel" / "node-server").
    nitro({ preset: process.env.NITRO_PRESET ?? "vercel" }),
  ],
});
