import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output gives a minimal server bundle for the non-root runtime image.
  output: "standalone",
  // Monorepo: trace dependencies from the repo root so workspace packages are included.
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@fincore/contracts"],
  // Same-origin API in dev/standalone; behind Caddy, /api is routed to Express before reaching Next.js.
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000"}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
