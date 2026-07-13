import { ArrowUp, FileText, Folder, FolderOpen } from "lucide-react";
import { useState } from "react";
import { api, type BrowseResult, type Memory, type SaveResult } from "./api";

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

export function AddFileCard({ onAdded }: { onAdded: () => void }) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The daemon-side filesystem picker: the browser can't reveal absolute paths itself.
  const [listing, setListing] = useState<BrowseResult | null>(null);

  async function browse(target?: string) {
    setError(null);
    try {
      setListing(await api.browse(target));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

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
      setListing(null);
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function ingestMany(targets: string[]) {
    setBusy(true);
    setError(null);
    setNotice(null);
    let files = 0;
    let unchanged = 0;
    let chunks = 0;
    const failures: string[] = [];
    for (const target of targets) {
      try {
        const r = await api.contextAdd(target);
        chunks += r.chunks;
        if (r.outcome === "unchanged") unchanged += 1;
        else files += r.documents ?? 1;
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err));
      }
    }
    setNotice(
      `ingested ${files} ${files === 1 ? "file" : "files"}` +
        `${unchanged ? ` (${unchanged} unchanged)` : ""} · ${chunks} chunks. ` +
        "Run index to extract entities.",
    );
    if (failures.length > 0) setError(failures.join("; "));
    setPath("");
    setBusy(false);
    onAdded();
  }

  // The OS-native dialog opens on this machine (the daemon IS local). Systems without
  // one (headless Linux) answer 501 — fall back to the in-app directory panel.
  async function pickNative(mode: "file" | "folder") {
    setError(null);
    setBusy(true);
    try {
      const { paths } = await api.pick(mode);
      setBusy(false);
      if (paths.length === 0) return; // cancelled
      if (paths.length === 1) await ingest(paths[0] ?? "");
      else await ingestMany(paths);
    } catch {
      setBusy(false);
      await browse(path.trim() || undefined);
    }
  }

  return (
    <div className="card">
      {error && <div className="notice noticeError">{error}</div>}
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
          onClick={() => void pickNative("file")}
        >
          Browse…
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => void pickNative("folder")}
        >
          Folder…
        </button>
        <button type="submit" className="btn btnPrimary" disabled={busy || path.trim() === ""}>
          {busy ? "Ingesting…" : "Add"}
        </button>
      </form>

      {listing && (
        <div className="fsBrowser">
          <div className="fsBrowserHead">
            <button
              type="button"
              className="btn btnGhost"
              disabled={!listing.parent}
              onClick={() => listing.parent && void browse(listing.parent)}
            >
              <ArrowUp size={12} strokeWidth={1.75} /> up
            </button>
            <span className="fsBrowserPath">{listing.path}</span>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                setPath(listing.path);
                void ingest(listing.path);
              }}
            >
              <FolderOpen size={12} strokeWidth={1.75} /> ingest this folder
            </button>
            <button type="button" className="btn btnGhost" onClick={() => setListing(null)}>
              close
            </button>
          </div>
          <div className="fsBrowserList">
            {listing.entries.length === 0 && (
              <div className="fsBrowserEmpty">nothing ingestible here</div>
            )}
            {listing.entries.map((entry) => (
              <button
                type="button"
                key={entry.path}
                className="fsBrowserRow"
                onClick={() => {
                  if (entry.kind === "dir") void browse(entry.path);
                  else {
                    setPath(entry.path);
                    void ingest(entry.path);
                  }
                }}
              >
                {entry.kind === "dir" ? (
                  <Folder size={13} strokeWidth={1.75} className="fsDirIcon" />
                ) : (
                  <FileText size={13} strokeWidth={1.75} />
                )}
                {entry.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {notice && <div className="resultOutcome outcome-added">{notice}</div>}
    </div>
  );
}
