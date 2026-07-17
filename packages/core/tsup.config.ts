import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  // pg lives in optionalDependencies, which tsup does not auto-externalize. Without this it
  // gets bundled into an ESM chunk where its internal require() calls throw at runtime.
  external: ["pg"],
});
