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
};

export default nextConfig;
