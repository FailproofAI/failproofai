import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "eslint.config.mjs", "integration/fixtures/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["scripts/*.mjs"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // This package talks to four frameworks and one wire protocol, all of
      // which hand it `unknown`. Narrowing every one of those at the boundary
      // is exactly what the adapters and the `fromWire` readers already do by
      // hand; the rules below would flag that work rather than the mistakes.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    files: ["test/**/*.ts", "integration/*.ts", "scripts/**/*.mjs"],
    rules: {
      // A test's whole job is to feed the wrong shape in and watch what
      // happens, so the casts it needs are the point rather than a smell.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/require-await": "off",
      // `await agent("x", () => 1)` is exactly what a caller writes, and the
      // scopes deliberately stay synchronous for a synchronous body — so the
      // value awaited here is sometimes a promise and sometimes not, which is
      // the behaviour under test rather than a mistake.
      "@typescript-eslint/await-thenable": "off",
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      // Build scripts run under plain Node, outside the typed project.
      globals: { process: "readonly", console: "readonly", URL: "readonly" },
    },
  },
);
