import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Emits .next/standalone with a minimal server and only the dependencies
   * actually reached at runtime. Without it the production image has to carry
   * all of node_modules, which matters on a VPS shared with Postgres, Garage
   * and n8n.
   */
  output: "standalone",

  /**
   * There is no personal data here — the app tracks flight prices — so the
   * clinical headers senadoc sets would be overkill. These two cost nothing.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
