// Copy the built viewer bundle into this package so the published CLI ships it and the
// daemon can serve it from disk (resolved relative to dist/). Run as part of `pnpm build`;
// the @memloom/viewer devDependency makes pnpm build the viewer first.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "..", "..", "apps", "viewer", "dist");
const target = join(here, "..", "viewer");

if (!existsSync(source)) {
  console.error(
    `embed-viewer: no viewer build at ${source} — run \`pnpm --filter @memloom/viewer build\` first.`,
  );
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log(`embed-viewer: copied viewer bundle -> ${target}`);
