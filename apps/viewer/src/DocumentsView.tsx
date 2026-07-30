import { Clock } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, type ContextDocument, type DocumentChunks } from "./api";
import { AddFileCard, AddLinkCard, RecallCard } from "./cards";

// Ingested context documents: what's mirrored, how it was chunked, and the drill-down to the
// chunks themselves. Removal is two-step (arm, then confirm) with no modal, matching the rest of
// the tool, and only deletes the mirror; the file on disk is untouched.

/** Recordings are chunked by time, so their breadcrumb is a clock range, not a heading. */
function isTimed(kind: string): boolean {
  return kind === "audio" || kind === "video";
}

/**
 * A link's path is the page it came from. Gated on the scheme rather than on the kind alone:
 * a row from an older store, or a hand-edited one, must not turn into an arbitrary href.
 */
function webUrl(doc: ContextDocument): string | null {
  return doc.kind === "link" && /^https?:\/\//i.test(doc.path) ? doc.path : null;
}

/**
 * Chunk text opens with its own breadcrumb: the chunker prepends it so a recalled passage
 * carries where it came from. Under a timestamp that repeat reads as a glitch, so it comes
 * off for recordings only; a heading still reads as the passage's own first line.
 */
function stripLeadingCrumb(content: string, headingPath: string | null): string {
  if (!headingPath) return content;
  const crumb = `${headingPath}\n\n`;
  return content.startsWith(crumb) ? content.slice(crumb.length) : content;
}

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

        <h2 className="sectionTitle">Add a link</h2>
        <AddLinkCard
          onAdded={() => {
            load();
            onChanged();
          }}
        />

        <h2 className="sectionTitle">Recall</h2>
        <RecallCard only="context" />

        <h2 className="sectionTitle">Documents{docs ? `; ${docs.length}` : ""}</h2>

        {error && <div className="notice noticeError">{error}</div>}
        {!docs && !error && <div className="spin">loading…</div>}

        {docs && docs.length === 0 && (
          <p style={{ color: "var(--text-faint)" }}>
            No documents yet. Add a file, a folder, a web page, or a recording above, or run{" "}
            <code>memloom context add &lt;path or url&gt;</code>. Everything is chunked, embedded,
            and fused into the same recall as memories.
          </p>
        )}

        {docs?.map((d) => {
          const chunks = open.get(d.id);
          const url = webUrl(d);
          const timed = isTimed(d.kind);
          return (
            <div key={d.id} className="card">
              <div className="docHead">
                <span className="docTitle">{d.title}</span>
                <span className="kindTag">{d.kind}</span>
                <span className="docMeta">
                  {d.chunkCount} {timed ? "passages" : "chunks"}; updated{" "}
                  {new Date(d.updatedAt).toLocaleString()}
                </span>
              </div>
              {url ? (
                <a className="docPath docPathLink" href={url} target="_blank" rel="noreferrer">
                  {url}
                </a>
              ) : (
                <div className="docPath">{d.path}</div>
              )}
              <div className="actions">
                <button type="button" className="btn" onClick={() => toggleChunks(d.id)}>
                  {chunks ? "Hide chunks" : "Show chunks"}
                </button>
                {/* A link has no file to hand the OS: open the page it was read from. */}
                {url && (
                  <a className="btn btnLink" href={url} target="_blank" rel="noreferrer">
                    Open page
                  </a>
                )}
                {/* Uploaded docs (browser dialog) have no file on the daemon's disk. */}
                {!url && !d.path.startsWith("upload://") && (
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
                      {timed && c.headingPath ? (
                        <div className="chunkTime">
                          <Clock size={12} strokeWidth={1.75} />
                          {c.headingPath}
                        </div>
                      ) : (
                        <div className="chunkCrumb">
                          {c.headingPath ?? `#${c.chunkIndex + 1}`}
                          {c.page != null ? `; p. ${c.page}` : ""}
                        </div>
                      )}
                      {timed ? stripLeadingCrumb(c.content, c.headingPath) : c.content}
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
