import type { NextConfig } from "next";
const config: NextConfig = {
  distDir: process.env.RAG_NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["node:sqlite"],
  experimental: { serverActions: { bodySizeLimit: "1mb" } },
};
export default config;
