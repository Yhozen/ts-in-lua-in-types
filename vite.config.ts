import { defineConfig } from "vite-plus";

/** Not ours (submodules), throwaway (experiments), or generated data. */
const ignored = [
  "vendor/**",
  "experiments/**",
  "oracle/**",
  ".run/**",
  "lua/lib.mini.d.ts",
  "docs/CENSUS.md",
  "docs/PROFILE.md",
  // The plan is the planner's; keep its tables as written.
  "docs/PLAN.md",
];

export default defineConfig({
  staged: {
    "*": "vp check --fix",
    // Type-check the whole project (not just staged files) with tsrs.
    "*.{ts,mts,cts,tsx}": () => "tsrs --noEmit --fast",
  },
  lint: {
    ignorePatterns: ignored,
    options: {
      // Keep type-aware lint rules, but leave type checking to tsrs
      // (`vp run typecheck`) so there's a single source of type errors.
      typeAware: true,
      typeCheck: false,
    },
  },
  fmt: {
    ignorePatterns: ignored,
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
