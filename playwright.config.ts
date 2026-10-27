import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: { baseURL: "http://127.0.0.1:3100", channel: "msedge", headless: true },
  webServer: {
    command: "npm run dev -- --port 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 120_000,
    env: { RAG_MODE: "demo", RAG_DB_PATH: resolve("data/e2e-rag.sqlite"), RAG_NEXT_DIST_DIR: ".next-e2e" },
  },
  workers: 1,
});
