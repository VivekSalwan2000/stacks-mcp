import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      // A floor, set just under what the offline tests reach today. Raise it when you add tests;
      // never lower it to get a change through. src/core/web.ts (the live TinyFish client) is
      // exercised by `npm run e2e` and `npm run qa`, not by unit tests.
      thresholds: { statements: 62, branches: 50, functions: 61, lines: 64 },
    },
  },
});
