import { useRef, useState } from "react";
import { api, fileToBase64, type Memory, type SaveResult } from "./api";

// Shared action cards: save a memory, recall, ingest a file. Used by the Console (both,
// unfiltered), the Memories tab (save + memory-only recall), and the Documents tab
// (add file + context-only recall).

export function SaveMemoryCard({
  onSaved,
  goToConflicts,
}: {
  onSaved: () => void;
  goToConflicts?: () => void;
}) {
  const [saveText, setSaveText] = useState("");
  const [canonical, setCanonical] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SaveResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="card">
      {error && <div className="notice noticeError">{error}</div>}
      <textarea
        value={saveText}
        onChange={(e) => setSaveText(e.target.value)}
        placeholder="Something worth remembering…"
      />
      <div className="formRow">
        <input
          type="text"
          value={canonical}
          onChange={(e) => setCanonical(e.target.value)}
          placeholder="Canonical title (optional)"
        />
        <button
          type="button"
          className="btn btnPrimary"
          disabled={saving || saveText.trim().length === 0}
          onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              const r = await api.save({
                content: saveText.trim(),
                ...(canonical.trim() ? { canonical: canonical.trim() } : {}),
              });
              setResult(r);
              setSaveText("");
              setCanonical("");
              onSaved();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {result && (
        <div className={`resultOutcome outcome-${result.outcome}`}>
          {result.outcome === "added" && `added ${result.id}`}
          {result.outcome === "merged" && `already known — merged into ${result.id}`}
          {result.outcome === "versioned" && `new version v${result.version ?? "?"}`}
          {result.outcome === "conflict" && (
            <>
              contradiction detected — both kept.
              {goToConflicts && (
                <button type="button" className="btn btnGhost" onClick={goToConflicts}>
                  Review conflict →
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function RecallCard({ only }: { only?: "memory" | "context" }) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Memory[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="card">
      {error && <div className="notice noticeError">{error}</div>}
      <form
        className="formRow"
        onSubmit={async (e) => {
          e.preventDefault();
          if (query.trim().length === 0) return;
          setBusy(true);
          setError(null);
          try {
            // The fuse ranks memories and context together; a scoped card over-fetches
            // and keeps only its kind, so the top hits are still the true best of it.
            const all = await api.recall(query.trim(), only ? 20 : undefined);
            setResults((only ? all.filter((m) => m.kind === only) : all).slice(0, 10));
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            only === "memory"
              ? "What do I remember about…"
              : only === "context"
                ? "What do my documents say about…"
                : "What do I know about…"
          }
        />
        <button type="submit" className="btn btnPrimary" disabled={busy || query.trim() === ""}>
          {busy ? "Recalling…" : "Recall"}
        </button>
      </form>
      {results?.length === 0 && (
        <div className="spin">
          {only === "context" ? "no document passages matched" : "no memories matched"}
        </div>
      )}
      {results?.map((m) => (
        <div key={m.id} className="recallItem">
          <div className="recallTitle">{m.canonical ?? m.content}</div>
          {m.canonical && <div className="recallContent">{m.content}</div>}
          <div className="recallMeta">
            similarity {(m.similarity ?? 0).toFixed(2)} · saved{" "}
            {new Date(m.createdAt).toLocaleString()}
            {m.source && (
              <>
                {" · from "}
                {m.source.title}
                {m.source.headingPath ? ` › ${m.source.headingPath}` : ""}
                {m.source.page != null ? ` (p. ${m.source.page})` : ""}
              </>
            )}
          </div>
          <div className="simBar">
            <div
              className="simBarFill"
              style={{ width: `${Math.round((m.similarity ?? 0) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

const SUPPORTED_EXTENSIONS = [".md", ".markdown", ".txt", ".pdf"];
const MAX_UPLOAD_FILES = 200;

function isSupported(name: string): boolean {
  const lower = name.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function AddFileCard({ onAdded }: { onAdded: () => void }) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  // Path-based ingest (the text field): the daemon reads its own disk, so the document
  // keeps a real path — "open file" works and re-adding the path detects changes.
  async function ingest(target: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api.contextAdd(target);
      setNotice(
        r.documents !== undefined
          ? `ingested ${r.documents} ${r.documents === 1 ? "file" : "files"}` +
              `${r.unchanged ? ` (${r.unchanged} unchanged)` : ""} · ${r.chunks} chunks. ` +
              "Run index to extract entities."
          : r.outcome === "unchanged"
            ? `"${r.title}" is unchanged — nothing to do`
            : `${r.outcome} "${r.title}" · ${r.chunks} chunks. Run index to extract entities.`,
      );
      setPath("");
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Dialog-based ingest: the browser's own file/folder dialog (same as the assistant's
  // "+"), which yields bytes, not paths — files upload to the daemon. A folder pick
  // enumerates everything inside, so unsupported files are filtered out here.
  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    const all = Array.from(files);
    const supported = all.filter((f) => isSupported(f.name)).slice(0, MAX_UPLOAD_FILES);
    const skipped = all.length - supported.length;
    if (supported.length === 0) {
      setError(`no supported files picked (${SUPPORTED_EXTENSIONS.join(", ")})`);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    let added = 0;
    let unchanged = 0;
    let chunks = 0;
    const failures: string[] = [];
    for (const file of supported) {
      try {
        const r = await api.contextUpload(file.name, await fileToBase64(file));
        chunks += r.chunks;
        if (r.outcome === "unchanged") unchanged += 1;
        else added += 1;
      } catch (err) {
        failures.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setNotice(
      `ingested ${added} ${added === 1 ? "file" : "files"}` +
        `${unchanged ? ` (${unchanged} unchanged)` : ""}` +
        `${skipped ? ` (${skipped} unsupported skipped)` : ""} · ${chunks} chunks. ` +
        "Run index to extract entities.",
    );
    if (failures.length > 0) setError(failures.join("; "));
    setBusy(false);
    onAdded();
  }

  return (
    <div className="card">
      {error && <div className="notice noticeError">{error}</div>}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={SUPPORTED_EXTENSIONS.join(",")}
        style={{ display: "none" }}
        onChange={(e) => {
          void upload(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        style={{ display: "none" }}
        // Non-standard but universal: makes the dialog pick a directory (recursive).
        {...({ webkitdirectory: "" } as object)}
        onChange={(e) => {
          void upload(e.target.files);
          e.target.value = "";
        }}
      />
      <form
        className="formRow"
        onSubmit={(e) => {
          e.preventDefault();
          if (path.trim()) void ingest(path.trim());
        }}
      >
        <input
          type="text"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="Path to a file (.md, .txt, .pdf) or a folder on this machine…"
        />
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
        >
          Browse…
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => folderInputRef.current?.click()}
        >
          Folder…
        </button>
        <button type="submit" className="btn btnPrimary" disabled={busy || path.trim() === ""}>
          {busy ? "Ingesting…" : "Add"}
        </button>
      </form>

      {notice && <div className="resultOutcome outcome-added">{notice}</div>}
    </div>
  );
}
