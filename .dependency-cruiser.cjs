/**
 * dependency-cruiser config for zhihu-radar
 *
 * Enforces a strict layered architecture:
 *
 *   types  →  config  →  { sources, processors, validators, outputs }  →  runtime
 *
 * Rules:
 *   - A lower layer MUST NOT import from a higher layer.
 *   - Siblings (sources/processors/validators/outputs) MUST NOT import each other.
 *   - Only runtime/ is allowed to orchestrate across layers.
 *
 * Every `forbidden` rule below has a `comment` field explaining WHY the rule
 * exists and HOW to fix violations. Future-you and future agents will read
 * these comments when a violation fires — treat them as teaching material,
 * not bureaucracy. If you find yourself wanting to bypass a rule, update the
 * comment first and explain the new understanding.
 */
module.exports = {
  forbidden: [
    /* ---------- generic hygiene ---------- */

    {
      name: "no-circular",
      severity: "error",
      comment:
        "Circular dependencies make code hard to reason about, break tree-shaking, " +
        "and usually signal that two modules should be one, or that one should " +
        "depend on an abstraction rather than a concrete sibling. " +
        "FIX: extract the shared piece into types/ or config/, or move the " +
        "orchestration up to runtime/.",
      from: {},
      to: { circular: true },
    },

    {
      name: "no-orphans",
      severity: "warn",
      comment:
        "This file isn't imported by anything and isn't an entry point. " +
        "Either it's dead code (delete it) or you forgot to wire it up. " +
        "FIX: import it where it should be used, or delete it. " +
        "Exception: config files, type-only files at package roots.",
      from: {
        orphan: true,
        pathNot: [
          "(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$", // dotfiles like .eslintrc
          "\\.d\\.ts$",
          "(^|/)tsconfig\\.json$",
          "(^|/)(vitest|eslint|dependency-cruiser)\\.config\\.(js|cjs|mjs|ts)$",
          "(^|/)src/runtime/", // runtime/ entry points are orphans by design
        ],
      },
      to: {},
    },

    /* ---------- layered architecture (HARD rules) ---------- */

    {
      name: "types-is-pure",
      severity: "error",
      comment:
        "types/ is the bottom of the stack and must stay pure. It must not import " +
        "from config/, sources/, processors/, validators/, outputs/, or runtime/. " +
        "WHY: types/ is loaded by every other layer. If it imports upward, we get " +
        "cycles and the whole dependency graph collapses. " +
        "FIX: if you need a value here, it's probably actually a constant — move " +
        "it to config/. If you need behavior, the type belongs in a higher layer.",
      from: { path: "^src/types/" },
      to: {
        path: "^src/(config|sources|processors|validators|outputs|runtime)/",
      },
    },

    {
      name: "config-only-depends-on-types",
      severity: "error",
      comment:
        "config/ holds constants and static configuration. It may import from " +
        "types/ for type shapes, but nothing else. " +
        "WHY: config is loaded very early by every layer; if it pulls in " +
        "sources/ or processors/, you get import-time side effects (network " +
        "calls, API clients being constructed) in places you didn't expect. " +
        "FIX: if your config needs to call something, that 'something' is not " +
        "config — it belongs in the layer that needs it, with config passed in " +
        "as a parameter.",
      from: { path: "^src/config/" },
      to: {
        path: "^src/(sources|processors|validators|outputs|runtime)/",
      },
    },

    {
      name: "sources-is-isolated",
      severity: "error",
      comment:
        "sources/ (knowledge scrapers) may only depend on types/ and config/. " +
        "It MUST NOT import from processors/, validators/, outputs/, or runtime/. " +
        "WHY: sources produces raw data; it doesn't know or care what happens " +
        "next. Keeping it isolated means we can swap scrapers, cache them, or " +
        "run them independently without dragging the whole pipeline along. " +
        "FIX: if you want to run sources → processors in one call, that's a " +
        "pipeline. Pipelines live in runtime/. Move the orchestration up.",
      from: { path: "^src/sources/" },
      to: { path: "^src/(processors|validators|outputs|runtime)/" },
    },

    {
      name: "processors-is-isolated",
      severity: "error",
      comment:
        "processors/ (Claude-based analysis) may only depend on types/ and config/. " +
        "It MUST NOT import from sources/, validators/, outputs/, or runtime/. " +
        "WHY: processors takes raw data in and returns structured analysis out. " +
        "It's a pure-ish transformation; it must not know where data came from " +
        "or where it's going. This lets us test processors with fixture data, " +
        "without a live scraper or a live report writer. " +
        "FIX: if you want processors to read from a scraper, don't — have " +
        "runtime/ call sources, then pass the result into processors.",
      from: { path: "^src/processors/" },
      to: { path: "^src/(sources|validators|outputs|runtime)/" },
    },

    {
      name: "validators-is-isolated",
      severity: "error",
      comment:
        "validators/ (quality checks) may only depend on types/ and config/. " +
        "It MUST NOT import from sources/, processors/, outputs/, or runtime/. " +
        "WHY: validators are predicates — they take data and return pass/fail " +
        "with reasons. They must not trigger side effects by importing upward. " +
        "FIX: if a validator needs to re-run a processor or re-fetch a source, " +
        "that's not a validator anymore; it's runtime logic.",
      from: { path: "^src/validators/" },
      to: { path: "^src/(sources|processors|outputs|runtime)/" },
    },

    {
      name: "outputs-is-isolated",
      severity: "error",
      comment:
        "outputs/ (report generators) may only depend on types/ and config/. " +
        "It MUST NOT import from sources/, processors/, validators/, or runtime/. " +
        "WHY: an output renders structured data into a file/string. It should " +
        "not fetch more data or re-analyze — that was someone else's job. " +
        "Keeping outputs pure lets us snapshot-test reports deterministically. " +
        "FIX: gather all the data you need first (in runtime/), then pass a " +
        "finalized struct into outputs/.",
      from: { path: "^src/outputs/" },
      to: { path: "^src/(sources|processors|validators|runtime)/" },
    },

    /* ---------- misc ---------- */

    {
      name: "no-test-in-src",
      severity: "error",
      comment:
        "Test files live in tests/ (or as *.test.ts next to nothing production " +
        "imports). Production src/ must not import from tests. " +
        "FIX: if you need fixture data shared between src and tests, put it in " +
        "a tests/fixtures/ directory and only tests import it.",
      from: { path: "^src/" },
      to: { path: "^tests/" },
    },

    {
      name: "not-to-dev-dep",
      severity: "error",
      comment:
        "This module is in dependencies (production) but imports from " +
        "devDependencies. That means shipping this code will break at runtime. " +
        "FIX: move the package to dependencies, or move the import to a file " +
        "that only dev tooling runs.",
      from: {
        path: "^(src)",
        pathNot: ["\\.(test|spec)\\.(js|mjs|cjs|ts|ls|coffee|litcoffee|coffee\\.md)$"],
      },
      to: {
        dependencyTypes: ["npm-dev"],
        dependencyTypesNot: ["type-only"],
      },
    },
  ],

  options: {
    doNotFollow: {
      path: ["node_modules"],
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: "tsconfig.json",
    },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types", "typings"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
      archi: {
        collapsePattern: "^(node_modules|packages|src|lib|app|test|spec)/[^/]+",
      },
    },
    includeOnly: "^(src|tests)/",
  },
};
