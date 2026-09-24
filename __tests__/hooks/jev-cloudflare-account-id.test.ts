// @vitest-environment node
/**
 * The account id in a Cloudflare URL is the account id.
 *
 * Cloudflare Workers AI serves Jev at `…/client/v4/accounts/<id>/ai/run`, so the
 * canonical endpoint a person copies out of the dashboard already names the
 * account. Asking for it again as `--account-id` asks for something they have
 * just typed — and the first real attempt to configure Cloudflare was refused
 * with "pass the account id as well" while the id sat in the rejected string.
 */
import { describe, it, expect } from "vitest";

import { accountIdFromUrl } from "@/src/hooks/jev-cli";

const ID = "dca9323a240513f78661151a9d164dcc";

describe("accountIdFromUrl", () => {
  it("reads the id out of the canonical run endpoint", () => {
    expect(accountIdFromUrl(`https://api.cloudflare.com/client/v4/accounts/${ID}/ai/run`)).toBe(ID);
  });

  it("reads it with a model path appended, and with a trailing slash", () => {
    expect(accountIdFromUrl(`https://api.cloudflare.com/client/v4/accounts/${ID}/ai/run/typesafe/jev`)).toBe(ID);
    expect(accountIdFromUrl(`https://api.cloudflare.com/client/v4/accounts/${ID}/`)).toBe(ID);
  });

  it("lower-cases it, since the id is hex and the account is the same account", () => {
    expect(accountIdFromUrl(`https://api.cloudflare.com/client/v4/accounts/${ID.toUpperCase()}/ai/run`)).toBe(ID);
  });

  it("says nothing when the Cloudflare URL carries no account segment", () => {
    expect(accountIdFromUrl("https://api.cloudflare.com/client/v4")).toBeNull();
    expect(accountIdFromUrl("https://api.cloudflare.com/client/v4/accounts")).toBeNull();
  });

  it("refuses a segment that is not 32 hex characters", () => {
    // Cloudflare ids are exactly 32 hex. Anything else is not one, and guessing
    // would send requests to an account nobody named.
    expect(accountIdFromUrl("https://api.cloudflare.com/client/v4/accounts/not-an-id/ai/run")).toBeNull();
    expect(accountIdFromUrl(`https://api.cloudflare.com/client/v4/accounts/${ID.slice(0, 31)}/ai/run`)).toBeNull();
    expect(accountIdFromUrl(`https://api.cloudflare.com/client/v4/accounts/${ID}f/ai/run`)).toBeNull();
  });

  it("only reads the PATH, so a query or fragment cannot inject one", () => {
    expect(accountIdFromUrl(`https://api.cloudflare.com/client/v4?x=/accounts/${ID}/`)).toBeNull();
    expect(accountIdFromUrl(`https://api.cloudflare.com/client/v4#/accounts/${ID}/`)).toBeNull();
  });

  it("only trusts a host this build knows is Cloudflare's", () => {
    // The whole point is that the id is Cloudflare's own routing. A lookalike
    // host naming an `accounts/<32 hex>` path is not evidence of anything.
    expect(accountIdFromUrl(`https://api.cloudflare.com.evil.test/client/v4/accounts/${ID}/ai/run`)).toBeNull();
    expect(accountIdFromUrl(`https://openrouter.ai/api/v1/accounts/${ID}/ai/run`)).toBeNull();
    expect(accountIdFromUrl(`https://api.typesafe.ai/v1/accounts/${ID}/ai/run`)).toBeNull();
  });

  it("does not throw on something that is not a URL", () => {
    for (const bad of ["", "not a url", "api.cloudflare.com/accounts", "://"]) {
      expect(accountIdFromUrl(bad)).toBeNull();
    }
  });
});
