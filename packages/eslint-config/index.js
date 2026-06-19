import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

/**
 * Shared ESLint flat config for every workspace member (apps + packages).
 * Consume from a member's eslint.config.js:
 *
 *   import config from "@cap/eslint-config";
 *   export default config;
 *
 * @type {import("eslint").Linter.Config[]}
 */
export default [
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/*.config.js",
      // TanStack Start / Nitro / Vite build output + generated route tree
      // (gitignored, but eslint flat config does not read .gitignore).
      "**/.output/**",
      "**/.vercel/**",
      "**/.nitro/**",
      "**/.tanstack/**",
      "**/routeTree.gen.ts",
      // Frozen design-baseline prototype (the visual gate's HTML/CSS/vanilla-JS
      // oracle, served as-is to a browser). Not app source — its `document`/
      // `window`/`customElements` usage is correct for the browser and must not
      // be linted as Node module code (stabilize-visual-baseline-path).
      "**/e2e/design-baseline/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  prettier,
];
