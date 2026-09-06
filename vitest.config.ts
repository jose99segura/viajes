import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    // Same alias as tsconfig.json, so tests import "@/lib/..." like the app.
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
