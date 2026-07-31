import { defineConfig } from "tsup";

export default defineConfig({
  // asr-worker is its own entry because it is loaded by path (`new Worker(url)`), never
  // imported: bundling it into index would leave nothing at the URL the spawn resolves.
  entry: ["src/index.ts", "src/asr-worker.ts"],
  format: ["esm"],
  // Types for the library entry only: the worker is loaded by path (`new Worker(url)`),
  // never imported, and the dts bundler cannot resolve node builtins for a bare entry.
  dts: { entry: "src/index.ts" },
  clean: true,
  sourcemap: true,
  // pg lives in optionalDependencies, which tsup does not auto-externalize. Without this it
  // gets bundled into an ESM chunk where its internal require() calls throw at runtime.
  external: ["pg"],
});
