import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import globals from "globals";
import prettier from "eslint-config-prettier";

export default defineConfig(
  {
    ignores: [
      "dist/**",
      "public/vendor/**",
      "data/**",
      "test-results/**",
      "playwright-report/**",
    ],
  },
  {
    files: ["**/*.{ts,mjs}"],
    extends: [js.configs.recommended, tseslint.configs.recommended, prettier],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    files: ["tests/browser/**/*.ts"],
    // Browser tests inspect the intentionally narrow window.sontrama debug API.
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
