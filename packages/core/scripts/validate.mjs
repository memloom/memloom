// Live end-to-end validation of the memloom engine against a real model. Proves the whole
// pipeline works with real embeddings + a real LLM, not just the deterministic test provider.
//
// Usage:
//   pnpm --filter @memloom/core build
//   OPENROUTER_API_KEY=sk-... node packages/core/scripts/validate.mjs
//
// Optional: OPENROUTER_EMBED_MODEL / OPENROUTER_LLM_MODEL to override the defaults.

import { Memloom, OpenRouterEmbeddings, OpenRouterLLM, PgliteAdapter } from "../dist/index.js";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("Set OPENROUTER_API_KEY to run the live validation.");
  process.exit(1);
}

const embedModel = process.env.OPENROUTER_EMBED_MODEL; // e.g. "qwen/qwen3-embedding-8b"
const llmModel = process.env.OPENROUTER_LLM_MODEL; // e.g. "google/gemini-2.5-flash"

const line = (s = "") => console.log(s);
const section = (s) => {
  line();
  line(`── ${s} ${"─".repeat(Math.max(0, 60 - s.length))}`);
};

async function main() {
  const storage = await PgliteAdapter.open(); // in-memory
  const memloom = new Memloom({
    storage,
    embedding: new OpenRouterEmbeddings({ apiKey, ...(embedModel ? { model: embedModel } : {}) }),
    llm: new OpenRouterLLM({ apiKey, ...(llmModel ? { model: llmModel } : {}) }),
    // dedup ON (default): we want the real belief pipeline.
  });
  await memloom.init();

  section("1. save three memories (belief pipeline ON)");
  const a = await memloom.save({ content: "The staging database is Postgres running on Fly.io." });
  line(`  saved #1  -> ${a.outcome}  (${a.id.slice(0, 8)})`);
  const b = await memloom.save({ content: "I prefer tabs over spaces in my editor." });
  line(`  saved #2  -> ${b.outcome}  (${b.id.slice(0, 8)})`);

  section("2. save a CONTRADICTION of #1 (should be flagged, not overwritten)");
  const c = await memloom.save({ content: "The staging database is MySQL hosted on AWS RDS." });
  line(
    `  saved #3  -> ${c.outcome}${c.conflictId ? `  conflict=${c.conflictId.slice(0, 8)}` : ""}`,
  );

  section("3. pending conflicts (human-in-the-loop)");
  const conflicts = await memloom.conflicts();
  for (const cf of conflicts) {
    line(`  NEW:      ${cf.incoming.content}`);
    for (const cand of cf.candidates) {
      line(`  EXISTING: ${cand.content}`);
      line(`  reason:   ${cand.reason}`);
    }
  }
  if (conflicts.length === 0)
    line("  (no conflict detected; the model did not classify these as contradictory)");

  if (conflicts[0]) {
    section("4. resolve the conflict: keep the new one (supersede)");
    await memloom.resolveConflict(conflicts[0].id, { action: "keep_new" });
    line("  resolved with keep_new; the old memory is now stale, reversible via revertConflict");
    line(`  pending conflicts now: ${(await memloom.conflicts()).length}`);
  }

  section("5. index -> extract entities into a graph");
  const idx = await memloom.index();
  line(`  indexed ${idx.indexed} memories`);
  const graph = await memloom.graph();
  line(
    `  entities: ${graph.entities.map((e) => `${e.name} (${e.entityType})`).join(", ") || "(none)"}`,
  );
  line(`  mention edges: ${graph.edges.filter((e) => e.relation === "mention").length}`);

  section("6. recall by meaning (hybrid: vector + keyword + entity)");
  const q1 = "what database do we use for staging?";
  const r1 = await memloom.recall(q1);
  line(`  query: "${q1}"`);
  for (const m of r1.slice(0, 3)) {
    line(
      `   - [sim ${(m.similarity ?? 0).toFixed(2)} | rrf ${(m.rrfScore ?? 0).toFixed(4)}] ${m.content}`,
    );
  }

  section("7. recall by entity name (entity arm anchors)");
  const q2 = "MySQL";
  const r2 = await memloom.recall(q2);
  line(`  query: "${q2}"`);
  for (const m of r2.slice(0, 3)) {
    line(
      `   - [sim ${(m.similarity ?? 0).toFixed(2)} | rrf ${(m.rrfScore ?? 0).toFixed(4)}] ${m.content}`,
    );
  }

  line();
  line("VALIDATION COMPLETE: the engine ran end-to-end on a real model.");
  await storage.close();
}

main().catch((err) => {
  console.error("\nVALIDATION FAILED:");
  console.error(err?.message ?? err);
  process.exit(1);
});
