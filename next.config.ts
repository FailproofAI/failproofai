import type { NextConfig } from "next";
// Static import (instead of `readFileSync(join(__dirname, "package.json"))`)
// keeps Turbopack's Node File Tracer from flagging this file as doing
// dynamic filesystem work, which produced an "Encountered unexpected file
// in NFT list" warning during `bun run build`.
import pkg from "./package.json";

const allowedDevOrigins = process.env.FAILPROOFAI_ALLOWED_DEV_ORIGINS
  ? process.env.FAILPROOFAI_ALLOWED_DEV_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
  : undefined;

/**
 * Never render inside another page's frame.
 *
 * Without these a page anywhere could load `localhost:8020/policies` in an
 * invisible iframe and steer the user's clicks onto it. Those clicks are
 * same-origin, so no Host, Origin or token check can tell them apart, and one
 * of them toggles a policy off. The dashboard never frames itself.
 * `X-Frame-Options` is for browsers that predate `frame-ancestors`.
 * (FailproofAI/agenteye#1799; first asked for in failproofai#165.)
 */
const FRAME_DENY_HEADERS = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
];

const nextConfig: NextConfig = {
  ...(allowedDevOrigins ? { allowedDevOrigins } : {}),
  async headers() {
    return [{ source: "/:path*", headers: FRAME_DENY_HEADERS }];
  },
  output: "standalone",
  outputFileTracingExcludes: {
    "*": [
      "node_modules/@img/**",
      "node_modules/sharp/**",
    ],
  },
  productionBrowserSourceMaps: false,
  turbopack: {
    root: __dirname,
  },
  images: {
    unoptimized: true,
  },
  webpack: (config) => {
    config.devtool = false;
    return config;
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
};

export default nextConfig;
