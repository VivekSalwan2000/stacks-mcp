import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "coverage/", "node_modules/", ".mcpb-build/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Unused things are mistakes, except names that start with an underscore.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "@typescript-eslint/consistent-type-imports": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      // stdout carries the MCP protocol in stdio mode: a stray console.log would corrupt it.
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },
  {
    // Plain Node scripts: tell ESLint about the globals TypeScript files get from their types.
    files: ["**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly", URL: "readonly" } },
  },
  {
    // Tests read recorded site data and call tool handlers loosely; scripts and the CLI entry point print to the terminal.
    files: ["test/**", "scripts/**", "src/index.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off", "no-console": "off" },
  },
);
