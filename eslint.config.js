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
    linterOptions: {
      // Escape-hatch guard: if a file has `// eslint-disable-next-line foo`
      // but rule `foo` wasn't actually firing on that line, that's a sign the
      // disable is either stale or was speculative cover. Error on it so the
      // easy path of "just add a disable comment" leaves fingerprints.
      reportUnusedDisableDirectives: "error",
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
      // Mechanize CLAUDE.md rule 3 ("don't silence, fix the code"). TS escape
      // comments are the single easiest way for an agent to turn a red check
      // green without fixing anything. Ban the unqualified forms; allow
      // `@ts-expect-error` only when the author writes a real explanation
      // (10+ chars), so the code review can see *why* the escape is needed.
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-check": false,
          "ts-expect-error": "allow-with-description",
          minimumDescriptionLength: 10,
        },
      ],
    },
  },
];
