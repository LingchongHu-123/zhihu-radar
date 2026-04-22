// ESLint 10 uses flat config. This file is loaded directly; no .eslintrc.
//
// Scope: we lint only TS files under src/ and tests/. We deliberately do NOT
// lint config/build files (tsconfig is enough for those).
//
// Keep this file small. Every rule we add is a rule that will eventually
// argue with a future agent. Only add a rule if we've seen the bug it
// prevents at least twice.

import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    ignores: [
      "node_modules/",
      "dist/",
      "coverage/",
      "data/",
      "**/*.d.ts",
      // config files — we don't lint our own tooling
      ".dependency-cruiser.cjs",
      "eslint.config.js",
      "vitest.config.*",
    ],
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        project: false, // type-aware linting off for now; turn on when it pays rent
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      // Start conservative. The tsconfig already catches most real bugs.
      "no-console": "off", // CLI tool: console.log is output, not a leak
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
];
