import nextConfig from "eslint-config-next/core-web-vitals";
import tsParser from "@typescript-eslint/parser";

const config = [
  // Skip generated bundles and design-asset reference files. assets/audit
  // is the brand team's reference HTML/JSX kit, not source code we ship.
  // integration-suite is a standalone Docker+shell test harness (Node CJS
  // scripts driven inside a container), not shipped source — like dist/assets.
  // sdk/typescript is its OWN npm package with its own tsconfig, eslint config
  // and vitest config, for the same reason sdk/python and fp-cloud-cli are
  // their own projects: linting it from here would mean this project's rules
  // and dependency tree decided whether that package's zero-dependency claim
  // holds. Its CI job runs `npm run lint` inside it.
  { ignores: ["dist/", "assets/", "integration-suite/", "sdk/typescript/"] },
  ...nextConfig,
  { settings: { react: { version: "19" } } },
  {
    files: ["**/*.{js,jsx,mjs,mts,cts}"],
    languageOptions: { parser: tsParser },
  },
];

export default config;

