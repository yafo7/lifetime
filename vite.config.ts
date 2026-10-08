import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { dedupe: ["three"] },
  worker: { format: "es" },
  optimizeDeps: {
    exclude: [
      "recast-navigation",
      "@recast-navigation/core",
      "@recast-navigation/wasm",
    ],
  },
  server: {
    port: 5190,
    strictPort: true,
    proxy: {
      "/api/resources":
        process.env.LIFETIME_RESOURCE_URL || "http://127.0.0.1:5191",
    },
  },
  test: { include: ["tests/**/*.test.ts"] },
});
