import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.test.ts"],
    // PGLite spins up a WASM Postgres per test; init is slow. Running test files in parallel
    // makes many WASM instances thrash each other into timeouts, so run files sequentially;
    // each then runs at full speed. Deterministic and only modestly slower wall-time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
