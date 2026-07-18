import {
  HashingEmbeddingProvider,
  Memloom,
  PgliteAdapter,
  ScriptedLLMProvider,
} from "@memloom/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteSchemaEntry,
  listConflicts,
  memoryHistory,
  readPassage,
  recallMemory,
  resolveConflict,
  saveMemory,
  setSchemaEntryStatus,
} from "./tools.js";

// The MCP tool functions are pure over a Memloom, so we test them directly (the stdio wiring
// in server.ts/bin.ts is thin). Uses a scripted LLM for the conflict path.

const contradictory = new ScriptedLLMProvider(
  () => '[{"candidate": 1, "relation": "contradictory", "reason": "different value"}]',
);

describe("mcp tools", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  async function fresh() {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const memloom = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: contradictory,
    });
    await memloom.init();
    return memloom;
  }

  it("save_memory then recall_memory", async () => {
    const m = await fresh();
    const saved = await saveMemory(m, { content: "the staging database is postgres" });
    expect(saved).toContain("Saved memory");

    const recalled = await recallMemory(m, { query: "staging database" });
    expect(recalled).toContain("staging database");
  });

  it("recall_memory formats items as title / content / saved / similarity lists", async () => {
    const m = await fresh();
    await saveMemory(m, {
      content: "the staging database is postgres",
      canonical: "staging DB engine",
    });
    await saveMemory(m, { content: "the staging database lives in Frankfurt" });

    const recalled = await recallMemory(m, { query: "staging database" });
    const items = recalled.split("\n---\n");
    expect(items).toHaveLength(2);

    // The canonical becomes the title; without one, the content leads.
    const titled = items.find((i) => i.startsWith("staging DB engine")) as string;
    const lines = titled.split("\n");
    expect(lines[1]).toBe("- the staging database is postgres");
    expect(lines[2]).toMatch(/^- saved \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
    expect(lines[3]).toMatch(/^- similarity \d\.\d{2}$/);

    const untitled = items.find((i) => !i.startsWith("staging DB engine")) as string;
    expect(untitled.startsWith("the staging database lives in Frankfurt")).toBe(true);
  });

  it("recall exposes a memory id, and memory_history returns the version chain", async () => {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const m = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: new ScriptedLLMProvider(() => "[]"),
    });
    await m.init();

    const a = await saveMemory(m, { content: "the api runs on port 3000" });
    const id = a.match(/Saved memory (\S+)\./)?.[1] as string;
    const recalled = await recallMemory(m, { query: "api port" });
    expect(recalled).toContain(`- id ${id}`);

    // Edit into a new version (a human action; driven directly here).
    await m.update({ id, content: "the api runs on port 4000" });
    const hist = await memoryHistory(m, { memoryId: id });
    const entries = hist.split("\n---\n");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toContain("v2 (current");
    expect(entries[0]).toContain("port 4000");
    expect(entries[1]).toContain("v1 (superseded");
  });

  it("recall truncates monster passages at the shared budget; read_passage serves the rest", async () => {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const m = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: new ScriptedLLMProvider(() => "[]"),
      dedup: false,
    });
    await m.init();

    // >8k chars with the payload past the cut: same budget as the viewer assistant.
    const big = `the release runbook starts here ${"step ".repeat(1800)}FINAL STEP AT THE END`;
    const saved = await m.save({ content: big });

    const recalled = await recallMemory(m, { query: "release runbook" });
    expect(recalled).toContain(
      `[truncated: call read_passage with id ${saved.id} for the full text]`,
    );
    expect(recalled).not.toContain("FINAL STEP AT THE END");

    const full = await readPassage(m, { id: saved.id });
    expect(full).toContain("FINAL STEP AT THE END");

    const missing = await readPassage(m, { id: "not-a-real-id" });
    expect(missing).toContain("No memory or document passage");
  });

  it("set_schema_entry_status disables and re-enables built-in and user entries", async () => {
    const m = await fresh();

    const disabledPerson = await setSchemaEntryStatus(m, {
      kind: "entity_type",
      name: "person",
      status: "disabled",
    });
    expect(disabledPerson).toContain('Disabled entity_type "person"');
    expect((await m.describeSchema()).entityTypes.find((t) => t.name === "person")?.status).toBe(
      "disabled",
    );

    const already = await setSchemaEntryStatus(m, {
      kind: "entity_type",
      name: "person",
      status: "disabled",
    });
    expect(already).toContain("already disabled");

    const enabledPerson = await setSchemaEntryStatus(m, {
      kind: "entity_type",
      name: "person",
      status: "active",
    });
    expect(enabledPerson).toContain('Enabled entity_type "person"');

    const missing = await setSchemaEntryStatus(m, {
      kind: "predicate",
      name: "not-a-real-predicate",
      status: "disabled",
    });
    expect(missing).toContain('No predicate named "not-a-real-predicate"');
  });

  it("delete_schema_entry deletes disabled user entries and explains refusals", async () => {
    const m = await fresh();
    await m.addSchemaEntry("entity_type", "medication", "a named drug");

    // Active user entry: told to disable first, nothing deleted.
    const refusedActive = await deleteSchemaEntry(m, { kind: "entity_type", name: "medication" });
    expect(refusedActive).toContain("Disable it first");

    // System entry: never deletable.
    const person = (await m.describeSchema()).entityTypes.find((t) => t.name === "person");
    await m.setSchemaStatus(person?.id ?? "", "disabled");
    const refusedSystem = await deleteSchemaEntry(m, { kind: "entity_type", name: "person" });
    expect(refusedSystem).toContain("built-in");
    await m.setSchemaStatus(person?.id ?? "", "active");

    // Disabled user entry: gone (name matching is case-insensitive).
    const entry = (await m.describeSchema()).entityTypes.find((t) => t.name === "medication");
    await m.setSchemaStatus(entry?.id ?? "", "disabled");
    const deleted = await deleteSchemaEntry(m, { kind: "entity_type", name: "Medication" });
    expect(deleted).toContain('Deleted entity_type "medication"');
    expect(
      (await m.describeSchema()).entityTypes.find((t) => t.name === "medication"),
    ).toBeUndefined();

    const missing = await deleteSchemaEntry(m, { kind: "predicate", name: "medication" });
    expect(missing).toContain('No predicate named "medication"');
  });

  it("save_memory reports a conflict, list + resolve work", async () => {
    const m = await fresh();
    await saveMemory(m, { content: "the deploy window is friday afternoon" });
    const conflicted = await saveMemory(m, { content: "the deploy window is monday morning" });
    expect(conflicted).toContain("CONTRADICTS");

    const list = await listConflicts(m);
    expect(list).toContain("Conflict");

    const conflictId = (await m.conflicts())[0]?.id as string;
    const resolved = await resolveConflict(m, { conflictId, action: "keep_new" });
    expect(resolved).toContain("keep_new");
    expect(await listConflicts(m)).toBe("No pending conflicts.");
  });
});
