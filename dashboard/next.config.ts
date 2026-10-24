import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @dibs/shared ships TypeScript source, so Next has to compile it.
  transpilePackages: ["@dibs/shared"],
};

export default nextConfig;
