import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HashingEmbeddingProvider, NullLLMProvider } from "./hashing-provider.js";
import { Memloom } from "./memloom.js";
import { PgliteAdapter } from "./pglite-adapter.js";

// End-to-end context connector: file → extract → chunk → embed → store → hybrid recall.
// Uses the offline hashing embeddings (word overlap = similarity), so keyword-ish queries
// retrieve deterministically.

/** Build a minimal but valid one-page PDF containing `text`, with correct xref offsets. */
function makePdf(text: string): Uint8Array {
  const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

describe("context connector", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  async function fresh() {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const memloom = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(256),
      llm: new NullLLMProvider(),
      dedup: false,
    });
    await memloom.init();
    const dir = mkdtempSync(join(tmpdir(), "memloom-ctx-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return { memloom, dir };
  }

  it("ingests markdown with heading breadcrumbs and recalls it with a source", async () => {
    const { memloom, dir } = await fresh();
    const path = join(dir, "setup.md");
    writeFileSync(
      path,
      "# Deploy Guide\n## Database\nthe staging database runs postgres seventeen with pgvector",
    );

    const added = await memloom.contextAdd({ path });
    expect(added.outcome).toBe("added");
    expect(added.title).toBe("Deploy Guide");
    expect(added.chunks).toBeGreaterThan(0);

    const results = await memloom.recall("staging database postgres");
    const chunk = results.find((r) => r.kind === "context");
    expect(chunk).toBeDefined();
    expect(chunk?.content).toContain("staging database");
    expect(chunk?.source?.title).toBe("Deploy Guide");
    expect(chunk?.source?.headingPath).toBe("Deploy Guide > Database");
    expect(chunk?.source?.path).toBe(path);
  });

  it("re-add is idempotent; a changed file replaces its chunks", async () => {
    const { memloom, dir } = await fresh();
    const path = join(dir, "notes.txt");
    writeFileSync(path, "the deploy window is friday afternoon");

    const first = await memloom.contextAdd({ path });
    expect(first.outcome).toBe("added");

    const again = await memloom.contextAdd({ path });
    expect(again.outcome).toBe("unchanged");
    expect(again.documentId).toBe(first.documentId);

    writeFileSync(path, "the deploy window moved to monday morning");
    const updated = await memloom.contextAdd({ path });
    expect(updated.outcome).toBe("updated");
    expect(updated.documentId).toBe(first.documentId);

    const results = await memloom.recall("deploy window");
    const contents = results.map((r) => r.content).join(" ");
    expect(contents).toContain("monday");
    expect(contents).not.toContain("friday");

    const docs = await memloom.contextList();
    expect(docs).toHaveLength(1);
  });

  it("ingests a PDF and keeps the page number", async () => {
    const { memloom, dir } = await fresh();
    const path = join(dir, "report.pdf");
    writeFileSync(path, makePdf("quarterly revenue grew twelve percent in the fourth quarter"));

    const added = await memloom.contextAdd({ path });
    expect(added.outcome).toBe("added");
    expect(added.chunks).toBe(1);

    const results = await memloom.recall("quarterly revenue fourth quarter");
    const chunk = results.find((r) => r.kind === "context");
    expect(chunk?.content).toContain("revenue");
    expect(chunk?.source?.page).toBe(1);
    expect(chunk?.source?.title).toBe("report.pdf");
  });

  it("fuses memories and chunks in one recall, and remove drops the document", async () => {
    const { memloom, dir } = await fresh();
    await memloom.save({ content: "the staging database password rotates monthly" });
    const path = join(dir, "db.md");
    writeFileSync(path, "# DB\nthe staging database runs postgres");
    const added = await memloom.contextAdd({ path });

    const results = await memloom.recall("staging database");
    const kinds = new Set(results.map((r) => r.kind));
    expect(kinds.has("memory")).toBe(true);
    expect(kinds.has("context")).toBe(true);

    await memloom.contextRemove(added.documentId);
    expect(await memloom.contextList()).toHaveLength(0);
    const after = await memloom.recall("staging database");
    expect(after.every((r) => r.kind === "memory")).toBe(true);
  });

  it("rejects unsupported file types", async () => {
    const { memloom, dir } = await fresh();
    const path = join(dir, "image.png");
    writeFileSync(path, "not really a png");
    await expect(memloom.contextAdd({ path })).rejects.toThrow(/unsupported file type/);
  });
});

// One document per file across the upload:// and linked namespaces: a link (the stronger
// identity, it refreshes from disk) absorbs upload snapshots of the same file; an upload
// whose content or filename already lives here creates nothing.
describe("upload/link dedup", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  async function fresh() {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const memloom = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(256),
      llm: new NullLLMProvider(),
      dedup: false,
    });
    await memloom.init();
    const dir = mkdtempSync(join(tmpdir(), "memloom-dedup-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return { memloom, storage, dir };
  }

  const CONTENT = "# Notes\nthe deploy window is friday afternoon";
  const bytes = (s: string) => new TextEncoder().encode(s);

  it("upload then link identical content: the snapshot becomes the link, chunks kept", async () => {
    const { memloom, storage, dir } = await fresh();
    const uploaded = await memloom.contextUpload({ filename: "notes.md", bytes: bytes(CONTENT) });
    expect(uploaded.outcome).toBe("added");

    const path = join(dir, "notes.md");
    writeFileSync(path, CONTENT);
    const linked = await memloom.contextAdd({ path });

    expect(linked.outcome).toBe("converted");
    expect(linked.rechunked).toBe(false);
    expect(linked.documentId).toBe(uploaded.documentId);
    expect(linked.path).toBe(path);
    const docs = await memloom.contextList();
    expect(docs).toHaveLength(1);
    expect(docs[0]?.path).toBe(path);
    // Same chunk rows survived the conversion: nothing to re-embed or re-extract.
    const chunkIds = await storage.query<{ id: string }>(
      "SELECT id FROM context_chunks WHERE document_id = $1",
      [uploaded.documentId],
    );
    expect(chunkIds.length).toBe(uploaded.chunks);
  });

  it("upload then link the same filename with changed content: converted and re-chunked", async () => {
    const { memloom, dir } = await fresh();
    const uploaded = await memloom.contextUpload({ filename: "notes.md", bytes: bytes(CONTENT) });

    const path = join(dir, "notes.md");
    writeFileSync(path, "# Notes\nthe deploy window moved to monday morning");
    const linked = await memloom.contextAdd({ path });

    expect(linked.outcome).toBe("converted");
    expect(linked.rechunked).toBe(true);
    expect(linked.documentId).toBe(uploaded.documentId);
    expect(await memloom.contextList()).toHaveLength(1);
    const results = await memloom.recall("deploy window monday");
    expect(results.some((r) => r.content.includes("monday"))).toBe(true);
  });

  it("link then upload identical content: nothing new, points at the link", async () => {
    const { memloom, dir } = await fresh();
    const path = join(dir, "notes.md");
    writeFileSync(path, CONTENT);
    const linked = await memloom.contextAdd({ path });

    const uploaded = await memloom.contextUpload({ filename: "notes.md", bytes: bytes(CONTENT) });
    expect(uploaded.outcome).toBe("exists");
    expect(uploaded.documentId).toBe(linked.documentId);
    expect(uploaded.path).toBe(path);
    expect(await memloom.contextList()).toHaveLength(1);
  });

  it("link then upload the same filename with different content: refused toward the link", async () => {
    const { memloom, dir } = await fresh();
    const path = join(dir, "notes.md");
    writeFileSync(path, CONTENT);
    const linked = await memloom.contextAdd({ path });

    const uploaded = await memloom.contextUpload({
      filename: "notes.md",
      bytes: bytes("# Notes\ncompletely different words in here"),
    });
    expect(uploaded.outcome).toBe("exists");
    expect(uploaded.documentId).toBe(linked.documentId);
    expect(uploaded.path).toBe(path);
    expect(await memloom.contextList()).toHaveLength(1);
  });

  it("re-linking heals a store that already has the duplicate pair", async () => {
    const { memloom, storage, dir } = await fresh();
    const path = join(dir, "notes.md");
    writeFileSync(path, CONTENT);
    const linked = await memloom.contextAdd({ path });
    // Recreate the pre-fix state: force a second row in the upload namespace.
    const dupUpload = await storage.query<{ id: string }>(
      `INSERT INTO context_documents (owner_id, path, title, kind, content_hash, chunk_count)
       SELECT owner_id, 'upload://notes.md', title, kind, content_hash, 0
       FROM context_documents WHERE id = $1 RETURNING id`,
      [linked.documentId],
    );

    const relinked = await memloom.contextAdd({ path });
    expect(relinked.outcome).toBe("unchanged");
    expect(relinked.absorbed).toBe(1);
    const docs = await memloom.contextList();
    expect(docs).toHaveLength(1);
    expect(docs[0]?.id).toBe(linked.documentId);
    expect(dupUpload[0]?.id).toBeTruthy();
  });

  it("uploading the same content under a different filename is still a duplicate", async () => {
    const { memloom } = await fresh();
    const first = await memloom.contextUpload({ filename: "notes.md", bytes: bytes(CONTENT) });
    const second = await memloom.contextUpload({ filename: "copy.md", bytes: bytes(CONTENT) });
    expect(second.outcome).toBe("exists");
    expect(second.documentId).toBe(first.documentId);
    expect(await memloom.contextList()).toHaveLength(1);
  });

  it("chat attachments stay session-scoped copies, never absorbed by globals", async () => {
    const { memloom, dir } = await fresh();
    const path = join(dir, "notes.md");
    writeFileSync(path, CONTENT);
    await memloom.contextAdd({ path });

    const attached = await memloom.contextAttach({ filename: "notes.md", bytes: bytes(CONTENT) });
    expect(attached.outcome).toBe("added");
    // The global list still shows only the linked doc; the attachment lives on the session.
    expect(await memloom.contextList()).toHaveLength(1);
    expect(await memloom.sessionAttachments(attached.sessionId)).toHaveLength(1);
  });
});
