import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryEngine, StorageAdapter } from "@memloom/core";
import {
  HashingEmbeddingProvider,
  Memloom,
  PgliteAdapter,
  ScriptedLLMProvider,
  truncateAll,
} from "@memloom/core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  addFile,
  addLink,
  deleteSchemaEntry,
  listConflicts,
  listDocuments,
  MAX_INLINE_MEDIA_SECONDS,
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

// One store for the whole file, emptied between tests. See test-store.ts: booting PGLite
// costs about six seconds and the tests themselves cost milliseconds, so a store per test
// spends effectively all of its wall clock on Postgres startup.
let storage: StorageAdapter;
beforeAll(async () => {
  storage = await PgliteAdapter.open();
});
afterAll(async () => {
  await storage.close();
});

// A small real page for the link path, served by a stubbed fetch: no test touches the
// network. Kept well under the fetcher's 100 KB "probably rendered in a browser" threshold,
// so a short article is taken at face value.
const PAGE =
  "<!doctype html><html><head><title>Write-Ahead Logging</title></head><body><article>" +
  "<h1>Write-Ahead Logging</h1>" +
  "<p>A write-ahead log records every change before it is applied to the database file, " +
  "so a crash can be recovered by replaying the log rather than by undoing partial work.</p>" +
  "<h2>Checkpointing</h2>" +
  "<p>A checkpoint copies pages from the log back into the database file and then truncates " +
  "the log, which is what keeps the log from growing without bound over a long run.</p>" +
  "</article></body></html>";

describe("mcp tools", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    vi.unstubAllGlobals();
    while (cleanups.length) await cleanups.pop()?.();
  });

  /** A throwaway directory that is removed when the test ends. */
  async function workDir() {
    const dir = await mkdtemp(join(tmpdir(), "memloom-mcp-tools-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
  }

  function serve(html: string) {
    vi.stubGlobal(
      "fetch",
      async () => new Response(html, { headers: { "content-type": "text/html" } }),
    );
  }

  async function fresh() {
    await truncateAll(storage);
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
    await truncateAll(storage);
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
    await truncateAll(storage);
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

  it("add_link saves a page as a context document and says a re-add changed nothing", async () => {
    const m = await fresh();
    serve(PAGE);

    const added = await addLink(m, { url: "https://www.sqlite.org/wal.html" });
    expect(added).toContain("Write-Ahead Logging");
    // The distinction the description leans on: this is source material, not a memory.
    expect(added).toContain("context document");

    const again = await addLink(m, { url: "https://www.sqlite.org/wal.html" });
    expect(again).toContain("unchanged");
    expect(await m.contextList()).toHaveLength(1);

    // Recall reaches the page's own text, with the URL as its source.
    const recalled = await recallMemory(m, { query: "checkpoint truncates the log" });
    expect(recalled).toContain("from Write-Ahead Logging");
  });

  it("add_link relays an extraction failure with its code instead of throwing", async () => {
    const m = await fresh();
    serve('<html><body><div id="root"></div></body></html>');

    const failed = await addLink(m, { url: "https://app.example.com/spa" });
    expect(failed).toMatch(/Could not save https:\/\/app\.example\.com\/spa/);
    expect(failed).toContain("[empty]");
    expect(await m.contextList()).toHaveLength(0);
  });

  it("add_file ingests a local file and no-ops on an unchanged re-add", async () => {
    const m = await fresh();
    const dir = await workDir();
    const path = join(dir, "runbook.md");
    await writeFile(path, "# Release runbook\n\nDrain the queue, then flip the feature flag.\n");

    const added = await addFile(m, { path });
    expect(added).toContain("Release runbook");
    expect(added).toContain("context document");
    expect(await addFile(m, { path })).toContain("unchanged");

    await writeFile(path, "# Release runbook\n\nDrain the queue, then page the on-call.\n");
    expect(await addFile(m, { path })).toContain("Updated");
    expect(await m.contextList()).toHaveLength(1);
  });

  it("add_file explains a missing path and an unreadable format rather than failing", async () => {
    const m = await fresh();
    const dir = await workDir();

    expect(await addFile(m, { path: join(dir, "nope.md") })).toContain("No such file");
    // A folder is a CLI job: contextAdd takes one file.
    expect(await addFile(m, { path: dir })).toContain("memloom context add");

    const image = join(dir, "diagram.png");
    await writeFile(image, "not really a png");
    const refused = await addFile(m, { path: image });
    expect(refused).toContain("Cannot ingest diagram.png");
    expect(refused).toContain(".md");
  });

  // The judgement call this stream had to make: an hour of audio is 8 to 11 minutes of
  // transcription, and a tool call that blocks that long is worse than one that refuses.
  it("add_file refuses long media and points at the CLI instead of blocking", async () => {
    const m = await fresh();
    const dir = await workDir();
    const path = join(dir, "interview.mp3");
    await writeFile(path, "pretend this is audio");

    const refused = await addFile(m, { path }, { mediaSeconds: async () => 45 * 60 });
    expect(refused).toContain("45 minutes long");
    expect(refused).toContain("memloom context add");
    // Nothing was ingested, so the refusal is not a half-done state to clean up.
    expect(await m.contextList()).toHaveLength(0);
  });

  it("add_file lets short media through to transcription", async () => {
    const m = await fresh();
    const dir = await workDir();
    const path = join(dir, "voice-memo.m4a");
    await writeFile(path, "pretend this is audio");

    // Under the ceiling, so the guard steps aside. The bytes are not real audio and the
    // machine may have no model or no ffmpeg, so what is asserted is that the failure comes
    // back as readable text with its code, never as a thrown tool error.
    const result = await addFile(m, { path }, { mediaSeconds: async () => 30 });
    expect(result).toContain("voice-memo.m4a");
    expect(result).toMatch(/\[(no_model|no_ffmpeg|no_asr|decode_failed|no_speech)\]/);
    expect(MAX_INLINE_MEDIA_SECONDS).toBeGreaterThan(30);
  });

  // bin.ts connects through `memloom serve`, so the engine these tools really hold is an
  // HttpMemloomClient: it rethrows a plain Error carrying the daemon's JSON body, and an
  // instanceof check would quietly stop relaying the moment the tool is used as it ships.
  it("relays a coded failure that arrived across HTTP, not just an in-process error", async () => {
    const daemon = (status: number, body: object) =>
      new Error(`memloom server ${status}: ${JSON.stringify(body)}`);
    const overHttp = {
      contextAddUrl: async () => {
        throw daemon(400, {
          error: "https://app.example.com/spa yielded only 200 characters",
          code: "likely_rendered",
          url: "https://app.example.com/spa",
        });
      },
      contextAdd: async () => {
        throw daemon(400, {
          error: "the Parakeet TDT 0.6b v3 model is not installed",
          code: "no_model",
        });
      },
    } as unknown as MemoryEngine;

    const link = await addLink(overHttp, { url: "https://app.example.com/spa" });
    expect(link).toContain("[likely_rendered]");
    expect(link).toContain("yielded only 200 characters");
    // The envelope is unwrapped, so an agent reads the daemon's sentence and not its status.
    expect(link).not.toContain("memloom server 400");

    const dir = await workDir();
    const media = join(dir, "talk.mp4");
    await writeFile(media, "pretend this is video");
    const file = await addFile(overHttp, { path: media }, { mediaSeconds: async () => 30 });
    expect(file).toContain("[no_model]");
    expect(file).toContain("is not installed");

    // An uncoded failure is still a real tool error rather than a message shaped like one.
    const broken = { contextAddUrl: async () => Promise.reject(new Error("socket hang up")) };
    await expect(
      addLink(broken as unknown as MemoryEngine, { url: "https://example.com" }),
    ).rejects.toThrow(/socket hang up/);
  });

  it("list_documents lists what is ingested, filters it, and says when nothing is", async () => {
    const m = await fresh();
    expect(await listDocuments(m)).toContain("No context documents yet");

    const dir = await workDir();
    const notes = join(dir, "notes.md");
    await writeFile(notes, "# Postgres notes\n\nvacuum runs nightly on the primary.\n");
    await addFile(m, { path: notes });
    serve(PAGE);
    await addLink(m, { url: "https://www.sqlite.org/wal.html" });

    const all = await listDocuments(m);
    expect(all).toContain("Postgres notes");
    expect(all).toContain("[md, ");
    expect(all).toContain("https://www.sqlite.org/wal.html");

    const filtered = await listDocuments(m, { filter: "sqlite" });
    expect(filtered).toContain("Write-Ahead Logging");
    expect(filtered).not.toContain("Postgres notes");

    expect(await listDocuments(m, { filter: "nothing-like-this" })).toContain("None of the 2");
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
