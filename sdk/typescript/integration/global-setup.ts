import type { TestProject } from "vitest/node";

import { fixtures, installFixture, packedTarball } from "./harness.js";

declare module "vitest" {
  export interface ProvidedContext {
    tarball: string;
  }
}

/**
 * Pack the SDK once and install every fixture before any test runs.
 *
 * A fixture that fails to install FAILS the run. There is no skip: the Python
 * SDK's integration job learned the hard way that "4 skipped" reads as green
 * while testing nothing (`AGENTEYE_TESTS_REQUIRE_FRAMEWORKS`), and a harness
 * whose only job is to prove the frameworks work cannot be allowed to pass
 * without them.
 */
export default async function setup(project: TestProject): Promise<void> {
  const tarball = packedTarball();
  project.provide("tarball", tarball);
  const only = process.env.FAILPROOFAI_IT_FIXTURES?.split(",").filter(Boolean);
  await Promise.all(
    fixtures()
      .filter((name) => !only || only.includes(name))
      .map((name) => installFixture(name, tarball)),
  );
}
