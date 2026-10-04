import type { NextConfig } from "next";

/**
 * Security headers for every route. No script-src here: a nonce-based CSP forces dynamic rendering of every
 * page (see node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md) and the MediaPipe WASM
 * needs 'wasm-unsafe-eval', so this CSP only covers framing, plugins, <base> and form targets.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
  },
];

const nextConfig: NextConfig = {
  headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
