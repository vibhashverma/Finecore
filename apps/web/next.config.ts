import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output gives a minimal server bundle for the non-root runtime image.
  output: "standalone",
  // Monorepo: trace dependencies from the repo root so workspace packages are included.
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  poweredByHeader: false,
  // The API owns its URLs (e.g. Swagger UI redirects /api/docs → /api/docs/); stripping slashes here caused a redirect loop.
  skipTrailingSlashRedirect: true,
  reactStrictMode: true,
  transpilePackages: ["@fincore/contracts"],
  // Same-origin API in dev/standalone; behind Caddy, /api is routed to Express before reaching Next.js.
  async rewrites() {
    const api = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000";
    return [
      // `:path*` drops a trailing slash when proxying, so the Swagger UI root needs an exact rule.
      { source: "/api/docs/", destination: `${api}/api/docs/` },
      { source: "/api/:path*", destination: `${api}/api/:path*` },
    ];
  },
};

export default nextConfig;
