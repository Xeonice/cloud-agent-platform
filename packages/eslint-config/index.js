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
    ignores: ["**/dist/**", "**/.next/**", "**/node_modules/**", "**/*.config.js"],
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
