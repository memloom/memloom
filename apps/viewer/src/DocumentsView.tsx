import { useCallback, useEffect, useState } from "react";
import { api, type ContextDocument, type DocumentChunks } from "./api";
import { AddFileCard, RecallCard } from "./cards";

// Ingested context documents: what's mirrored, how it was chunked, and the drill-down to the
// chunks themselves. Removal is two-step (arm, then confirm) with no modal, matching the rest of
// the tool, and only deletes the mirror; the file on disk is untouched.

export function DocumentsView({ onChanged }: { onChanged: () => void }) {
  const [docs, setDocs] = useState<ContextDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Map<string, DocumentChunks>>(new Map());
  const [arming, setArming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .documents()
      .then(setDocs)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);
  useEffect(load, [load]);

  async function toggleChunks(id: string) {
    if (open.has(id)) {
      const next = new Map(open);
      next.delete(id);
      setOpen(next);
      return;
    }
    setError(null);
    try {
      const dc = await api.documentChunks(id);
      setOpen((prev) => new Map(prev).set(id, dc));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(id: string) {
    if (arming !== id) {
      setArming(id);
      return;
    }
    setBusy(id);
    setError(null);
    try {
      await api.removeDocument(id);
      setArming(null);
      load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="panel">
      <div className="panelInner">
        <h2 className="sectionTitle">Add a file/folder</h2>
        <AddFileCard
          onAdded={() => {
            load();
            onChanged();
          }}
        />

        <h2 className="sectionTitle">Recall</h2>
        <RecallCard only="context" />

        <h2 className="sectionTitle">Documents {docs ? `· ${docs.length}` : ""}</h2>

        {error && <div className="notice noticeError">{error}</div>}
        {!docs && !error && <div className="spin">loading…</div>}

        {docs && docs.length === 0 && (
          <p style={{ color: "var(--text-faint)" }}>
            No documents yet. Ingest files with <code>memloom context add &lt;path&gt;</code>,
            they're chunked, embedded, and fused into the same recall as memories.
          </p>
        )}

        {docs?.map((d) => {
          const chunks = open.get(d.id);
          return (
            <div key={d.id} className="card">
              <div className="docHead">
                <span className="docTitle">{d.title}</span>
                <span className="kindTag">{d.kind}</span>
                <span className="docMeta">
                  {d.chunkCount} chunks · updated {new Date(d.updatedAt).toLocaleString()}
                </span>
              </div>
              <div className="docPath">{d.path}</div>
              <div className="actions">
                <button type="button" className="btn" onClick={() => toggleChunks(d.id)}>
                  {chunks ? "Hide chunks" : "Show chunks"}
                </button>
                {/* Uploaded docs (browser dialog) have no file on the daemon's disk. */}
                {!d.path.startsWith("upload://") && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      api
                        .openDocument(d.id)
                        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
                    }
                  >
                    Open file
                  </button>
                )}
                <button
                  type="button"
                  className={`btn btnDanger ${arming === d.id ? "btnDangerArmed" : ""}`}
                  disabled={busy === d.id}
                  onClick={() => remove(d.id)}
                  onBlur={() => setArming((a) => (a === d.id ? null : a))}
                >
                  {arming === d.id ? "Confirm remove" : "Remove"}
                </button>
              </div>
              {chunks && (
                <div className="chunkList">
                  {chunks.chunks.map((c) => (
                    <div key={c.id} className="statement">
                      <div className="chunkCrumb">
                        {c.headingPath ?? `#${c.chunkIndex + 1}`}
                        {c.page != null ? ` · p. ${c.page}` : ""}
                      </div>
                      {c.content}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
