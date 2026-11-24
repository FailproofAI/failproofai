// @vitest-environment jsdom
// captureClientEvent reads window.location for $current_url/$pathname, so this
// one needs a DOM despite being a .ts file. Same per-file opt-in as
// share-card.test.ts and fetch-with-timeout.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  setClientTelemetryConfig,
  captureClientEvent,
  telemetryRoute,
} from "@/lib/client-telemetry";
import type { TelemetryConfig } from "@/app/actions/get-telemetry-config";

const enabledConfig: TelemetryConfig = {
  enabled: true,
  distinctId: "test-id",
  apiKey: "phc_test",
  host: "https://test.posthog.com",
  version: "1.0.0-test",
};

describe("client-telemetry", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    // Reset config to null by setting a disabled config then re-enabling
    setClientTelemetryConfig(null as unknown as TelemetryConfig);
  });

  it("no-ops when config is null", () => {
    captureClientEvent("$pageview");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no-ops when config.enabled is false", () => {
    setClientTelemetryConfig({ ...enabledConfig, enabled: false });
    captureClientEvent("$pageview");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("calls fetch with correct PostHog payload when enabled", () => {
    setClientTelemetryConfig(enabledConfig);
    captureClientEvent("$pageview", { extra: "prop" });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://test.posthog.com/capture/");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(opts.body);
    expect(body.api_key).toBe("phc_test");
    expect(body.event).toBe("$pageview");
    expect(body.distinct_id).toBe("test-id");
    expect(body.properties.$lib).toBe("failproofai-web");
    expect(body.properties.failproofai_version).toBe("1.0.0-test");
    expect(body.properties.product).toBe("failproofai-oss");
    expect(body.properties.extra).toBe("prop");
  });

  it("sets keepalive:true so events survive a page navigation/unload", () => {
    setClientTelemetryConfig(enabledConfig);
    captureClientEvent("$pageview");
    expect(fetchSpy.mock.calls[0][1].keepalive).toBe(true);
  });

  it("includes $current_url and $pathname in properties", () => {
    setClientTelemetryConfig(enabledConfig);
    captureClientEvent("$pageview");

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.properties).toHaveProperty("$current_url");
    expect(body.properties).toHaveProperty("$pathname");
  });

  it("strips trailing slashes from host before appending /capture/", () => {
    setClientTelemetryConfig({ ...enabledConfig, host: "https://test.posthog.com/" });
    captureClientEvent("$pageview");

    const url = fetchSpy.mock.calls[0][0];
    expect(url).toBe("https://test.posthog.com/capture/");
  });

  it("swallows fetch errors silently", () => {
    fetchSpy.mockRejectedValue(new Error("network failure"));
    setClientTelemetryConfig(enabledConfig);

    // Should not throw
    expect(() => captureClientEvent("$pageview")).not.toThrow();
  });
});

// FailproofAI/agenteye#1799. Every event carried the page's full address and
// raw error text. The address is this machine's data: the project slug is the
// project's absolute directory, the session id names one session, and the
// query string holds filters and project names. Error messages can hold
// anything that was on the page.
describe("client-telemetry sends nothing of the user's", () => {
  const PROJECT = "-home-alice-acme-merger";
  const SESSION = "0b1c7a5e-2f7d-4c55-9a59-6d1f00c0ffee";
  let fetchSpy: ReturnType<typeof vi.fn>;
  const sent = () => JSON.parse(fetchSpy.mock.calls[0][1].body as string) as { properties: Record<string, unknown> };

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    setClientTelemetryConfig(enabledConfig);
  });

  it("reports the page's route pattern, never its path, query or hash", () => {
    window.history.pushState({}, "", `/project/${PROJECT}/session/${SESSION}?cli=codex#turn-4`);
    captureClientEvent("$pageview");
    const { properties } = sent();
    expect(properties.$current_url).toBe("/project/[name]/session/[sessionId]");
    expect(properties.$pathname).toBe("/project/[name]/session/[sessionId]");
    const body = fetchSpy.mock.calls[0][1].body as string;
    for (const leaked of ["alice", "acme", SESSION, "codex", "turn-4", "localhost"]) {
      expect(body).not.toContain(leaked);
    }
  });

  it("drops the query string that names a project on /audit", () => {
    window.history.pushState({}, "", `/audit?p=${PROJECT}`);
    captureClientEvent("$pageview");
    expect(sent().properties.$current_url).toBe("/audit");
    expect(fetchSpy.mock.calls[0][1].body).not.toContain("alice");
  });

  it("reports an unknown path as [other], not as itself", () => {
    window.history.pushState({}, "", "/home/alice/secret-plans");
    captureClientEvent("$pageview");
    expect(sent().properties.$pathname).toBe("[other]");
    expect(fetchSpy.mock.calls[0][1].body).not.toContain("alice");
  });

  it("never sends an error's message, whoever passes it, and keeps what locates the code", () => {
    window.history.pushState({}, "", `/project/${PROJECT}`);
    captureClientEvent("unhandled_exception", {
      error_message: `ENOENT: no such file or directory, open '/home/alice/${PROJECT}/.env'`,
      error_name: "TypeError",
      error_digest: "3417721431",
      error_filename: `${window.location.origin}/_next/static/chunks/app/project/%5Bname%5D/page-1a2b.js`,
      error_lineno: 1,
      error_colno: 2048,
    });
    const { properties } = sent();
    expect(properties).not.toHaveProperty("error_message");
    expect(properties.error_name).toBe("TypeError");
    expect(properties.error_digest).toBe("3417721431");
    expect(properties.error_filename).toBe("/_next/static/chunks/app/project/%5Bname%5D/page-1a2b.js");
    expect(properties.error_lineno).toBe(1);
    expect(properties.error_colno).toBe(2048);
    expect(fetchSpy.mock.calls[0][1].body).not.toContain("alice");
  });

  it("reduces an inline script's location, which is the page's own address, to its route", () => {
    captureClientEvent("unhandled_exception", {
      error_filename: `${window.location.origin}/project/${PROJECT}/session/${SESSION}?cli=codex`,
    });
    expect(sent().properties.error_filename).toBe("/project/[name]/session/[sessionId]");
  });

  it("sends any location a caller passes (the navbar's from_path) as its route", () => {
    captureClientEvent("audit_nav_clicked", {
      from_path: `/project/${PROJECT}/session/${SESSION}`,
      back_to: `${window.location.origin}/project/${PROJECT}?cli=codex`,
      docs: "https://docs.example.com/home/alice",
      is_active_tab: false,
    });
    const { properties } = sent();
    expect(properties.from_path).toBe("/project/[name]/session/[sessionId]");
    expect(properties.back_to).toBe("/project/[name]");
    // Not a location in this app: passed through as the caller wrote it.
    expect(properties.docs).toBe("https://docs.example.com/home/alice");
    expect(properties.is_active_tab).toBe(false);
    expect(fetchSpy.mock.calls[0][1].body).not.toContain(SESSION);
  });

  it("keeps the structured properties callers send", () => {
    captureClientEvent("activity_filter_changed", { has_session: true, active_filter_count: 2, cli: "codex" });
    expect(sent().properties).toMatchObject({ has_session: true, active_filter_count: 2, cli: "codex" });
  });
});

describe("telemetryRoute covers every page the app has", () => {
  /** Every `page.tsx` under app/, as the route pattern Next serves it at. */
  function pageRoutes(dir: string, root: string): string[] {
    const routes: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) routes.push(...pageRoutes(full, root));
      else if (entry === "page.tsx") {
        const segments = relative(root, dir).split(sep).filter((s) => s && !/^\(.*\)$/.test(s));
        routes.push(`/${segments.join("/")}`);
      }
    }
    return routes;
  }

  const routes = pageRoutes(join(__dirname, "../../app"), join(__dirname, "../../app"));

  it("finds the app's pages", () => {
    expect(routes).toContain("/policies");
    expect(routes).toContain("/project/[name]/session/[sessionId]");
  });

  it.each(routes)("maps %s to its own pattern, with no value of its dynamic segments", (route) => {
    const sample = route.replace(/\[[^\]]+\]/g, "-home-alice-secret");
    expect(telemetryRoute(sample)).toBe(route);
  });
});
