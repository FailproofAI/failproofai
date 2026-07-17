import nextConfig from "eslint-config-next/core-web-vitals";
import tsParser from "@typescript-eslint/parser";

const config = [
  // Skip generated bundles and design-asset reference files. assets/audit
  // is the brand team's reference HTML/JSX kit, not source code we ship.
  // ci/cli-integration is a standalone Docker+shell test harness (Node CJS
  // scripts driven inside a container), not shipped source — like dist/assets.
  { ignores: ["dist/", "assets/", "ci/"] },
  ...nextConfig,
  { settings: { react: { version: "19" } } },
  {
    files: ["**/*.{js,jsx,mjs,mts,cts}"],
    languageOptions: { parser: tsParser },
  },
];

export default config;

