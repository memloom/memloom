import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDistillPrompt } from "../packages/core/src/distill.js";
import { chunksOf, loadFixtures } from "./lib/fixtures.js";
import { buildProvider } from "./lib/providers.js";

// Print the raw model reply for one fixture, before parsing: pnpm eval:raw voice-09. This is
// how "dropped by parser" gets explained (the first use found gemini answering type "decision").
async function main() {
  const id = process.argv[2] ?? "voice-09";
  const here = dirname(fileURLToPath(import.meta.url));
  const fixture = loadFixtures(join(here, "fixtures")).find((f) => f.id === id);
  if (!fixture) throw new Error(`no fixture ${id}`);
  const llm = buildProvider("openrouter", "google/gemini-2.5-flash", { maxUsd: 0.05 });
  for (const chunk of chunksOf(fixture)) {
    const raw = await llm.complete(
      buildDistillPrompt(chunk, { kind: fixture.kind, recordedAt: fixture.date }),
    );
    console.log(raw);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
