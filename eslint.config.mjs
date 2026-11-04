// ABOUTME: ESLint configuration using Obsidian's recommended plugin rules.
// ABOUTME: Mirrors the automated checks run on community plugin releases.

import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import { DEFAULT_BRANDS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js";

export default defineConfig([
  {
    // Only plugin code ships to users; tests, scripts and tool configs run under Node.
    ignores: [
      "main.js",
      "dist/**",
      "coverage/**",
      "node_modules/**",
      ".worktrees/**",
      "scripts/**",
      "tests/**",
      "esbuild.config.mjs",
      "jest.config.cjs",
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.*"],
        },
      },
    },
    rules: {
      "obsidianmd/ui/sentence-case": [
        "warn",
        {
          brands: [...DEFAULT_BRANDS, "Linear", "Flow", "Focus"],
          ignoreRegex: [
            // Example Linear links shown as placeholders
            "^https://linear\\.app/",
            // Help text quoting Linear's key format and the names on its settings page
            "lin_api_",
          ],
        },
      ],
    },
  },
]);
