// @vitest-environment node
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

describe("Hermes native plugin", () => {
  it("passes its Python protocol, state-machine, and hook mapping tests", () => {
    const result = spawnSync(
      "python3",
      [resolve("__tests__/fixtures/hermes-native-plugin-check.py")],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
