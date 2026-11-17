import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return {
      afterFiles: [
        {
          source: "/api/v1/:path*",
          destination: "/api/v1-router?__v1_path=:path*",
        },
      ],
    };
  },
};

export default nextConfig;
