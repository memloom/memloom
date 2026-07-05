import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.test.ts"],
    // PGLite spins up a WASM Postgres per test; init is slow and several run in parallel.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
