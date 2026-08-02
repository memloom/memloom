import { Clock, Play, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type ContextDocument,
  type ContextRootsResult,
  type DocumentChunks,
  type DocumentSpeaker,
  type SpeakerRoster,
} from "./api";
import { AddFileCard, AddLinkCard, IngestQueueCard, RecallCard } from "./cards";
import { cachedData, prefetch, refetch } from "./prefetch";

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

/** "12:30" for a sample offset; recordings under an hour never need the hour digit here. */
function sampleClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/**
 * The diarized voices of one recording: who talked, for how long, a playable sample of each
 * voice, and an inline rename. The Descript pattern, without the wizard: every speaker is a
 * row, the sample answers "who is this?", and naming one rewrites its transcript labels.
 *
 * Playback asks the daemon to CUT the sample (ffmpeg -> small mono WAV) rather than
 * streaming the original file: the browser cannot decode every container the daemon can
 * ingest (Chromium refuses Matroska in a media element), and a clip is a few hundred KB
 * where the recording is gigabytes. One hidden <audio> is reused across speakers.
 */
function SpeakerPanel({
  doc,
  canPlay,
  onRoster,
  onError,
}: {
  doc: ContextDocument;
  canPlay: boolean;
  onRoster: (documentId: string, roster: SpeakerRoster) => void;
  onError: (message: string) => void;
}) {
  const speakers = doc.speakers?.speakers ?? [];
  const [playing, setPlaying] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stop = () => {
    audioRef.current?.pause();
    setPlaying(null);
  };

  async function play(s: DocumentSpeaker) {
    if (playing === s.id) {
      stop();
      return;
    }
    const el = audioRef.current;
    if (!el) return;
    try {
      // The clip is exactly the sample range, so there is nothing to seek or stop early;
      // it plays through and onEnded clears the state.
      el.src = api.documentSampleUrl(doc.id, s.sampleStart, s.sampleEnd);
      await el.play();
      setPlaying(s.id);
    } catch {
      onError("could not load a voice sample for this recording");
    }
  }

  async function save(s: DocumentSpeaker) {
    const name = draft.trim();
    setEditing(null);
    if (name.length === 0 || name === (s.name ?? s.label)) return;
    setSaving(s.id);
    try {
      const res = await api.renameSpeaker(doc.id, s.id, name);
      onRoster(doc.id, res.speakers);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="speakerPanel">
      <div className="chunkCrumb">speakers</div>
      {canPlay && (
        // biome-ignore lint/a11y/useMediaCaption: a voice-sample player has no captions to offer
        <audio ref={audioRef} preload="none" onEnded={() => setPlaying(null)} />
      )}
      {speakers.map((s) => (
        <div key={s.id} className="speakerRow">
          {canPlay && (
            <button
              type="button"
              className="btn btnIcon"
              title={`play a sample of this voice (${sampleClock(s.sampleStart)})`}
              onClick={() => play(s)}
            >
              {playing === s.id ? (
                <Square size={12} strokeWidth={1.75} />
              ) : (
                <Play size={12} strokeWidth={1.75} />
              )}
            </button>
          )}
          {editing === s.id ? (
            <input
              className="speakerInput"
              value={draft}
              // biome-ignore lint/a11y/noAutofocus: the input appears in response to the user's own click to rename; focus following that click is the accessible behavior
              autoFocus
              placeholder={s.label}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => save(s)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save(s);
                if (e.key === "Escape") setEditing(null);
              }}
            />
          ) : (
            <button
              type="button"
              className="speakerName"
              disabled={saving === s.id}
              title="rename this speaker"
              onClick={() => {
                setDraft(s.name ?? "");
                setEditing(s.id);
              }}
            >
              {s.name ?? s.label}
            </button>
          )}
          <span className="docMeta">
            {s.name ? `was ${s.label}; ` : ""}
            {sampleClock(s.seconds)} of talk
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The folders memloom is following. Linking a folder puts it here and starts watching it, which
 * is what makes a file dropped in tomorrow become recallable without anyone re-adding it.
 *
 * Two separate actions, because they answer different questions. Stop watching leaves the
 * folder on the list, switched off. Forget removes the folder and keeps every document it
 * produced, because "stop following this folder" is never "delete what you read in it".
 */
function WatchedFolders({ onChanged }: { onChanged: () => void }) {
  const [state, setState] = useState<ContextRootsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [arming, setArming] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .contextRoots()
      .then(setState)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);
  useEffect(load, [load]);

  async function act(id: string, run: () => Promise<unknown>) {
    setBusy(id);
    setError(null);
    try {
      await run();
      setArming(null);
      load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const roots = state?.roots ?? [];
  if (state && roots.length === 0 && state.enabled) return null;

  return (
    <>
      <h2 className="sectionTitle">Watched folders{roots.length > 0 ? `; ${roots.length}` : ""}</h2>
      {error && <div className="notice noticeError">{error}</div>}
      {/* Nothing watched and nothing watching are different answers, and a reader who cannot
          tell them apart will wait forever for a folder that was never going to sync. */}
      {state && !state.enabled && (
        <div className="notice">
          Watching is off in this daemon (<code>MEMLOOM_SYNC=off</code>). Linked folders are
          recorded, and nothing is re-ingested until it is back on.
        </div>
      )}
      {roots.map((r) => (
        <div key={r.id} className="card">
          <div className="docHead">
            <span className="docTitle">
              {r.path.split(/[\\/]/).filter(Boolean).pop() ?? r.path}
            </span>
            <span className="kindTag">{r.watching ? "watching" : "paused"}</span>
            <span className="docMeta">
              {r.documents} {r.documents === 1 ? "document" : "documents"}
              {r.lastScanAt
                ? `; checked ${new Date(r.lastScanAt).toLocaleString()}`
                : "; not yet checked"}
            </span>
          </div>
          <div className="docPath">{r.path}</div>
          <div className="actions">
            <button
              type="button"
              className="btn"
              disabled={busy === r.id}
              onClick={() => act(r.id, () => api.watchRoot(r.id, !r.watching))}
            >
              {r.watching ? "Stop watching" : "Start watching"}
            </button>
            <button
              type="button"
              className={`btn btnDanger ${arming === r.id ? "btnDangerArmed" : ""}`}
              disabled={busy === r.id}
              onClick={() => {
                if (arming !== r.id) setArming(r.id);
                else void act(r.id, () => api.forgetRoot(r.id));
              }}
              onBlur={() => setArming((a) => (a === r.id ? null : a))}
            >
              {arming === r.id ? "Confirm forget" : "Forget folder"}
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

export function DocumentsView({ onChanged }: { onChanged: () => void }) {
  // Seeded from the prefetch cache: a hover on the tab (or an earlier visit) already
  // fetched the list, so the first render shows documents and revalidates behind them.
  const [docs, setDocs] = useState<ContextDocument[] | null>(() =>
    cachedData<ContextDocument[]>("documents"),
  );
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Map<string, DocumentChunks>>(new Map());
  const [arming, setArming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Mount revalidates through the shared cache; every mutation path in this view calls
  // `load` too, so it busts the cache rather than risking a stale readback.
  const revalidate = useCallback(() => {
    prefetch("documents", api.documents)
      .then(setDocs)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);
  const load = useCallback(() => {
    refetch("documents", api.documents)
      .then(setDocs)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);
  useEffect(revalidate, [revalidate]);

  // A rename changed the roster and rewrote chunk breadcrumbs on the daemon: patch the
  // roster in place and refetch the chunks if they are on screen, so both tell one story.
  const onRoster = useCallback((documentId: string, roster: SpeakerRoster) => {
    setDocs((prev) =>
      prev ? prev.map((d) => (d.id === documentId ? { ...d, speakers: roster } : d)) : prev,
    );
    setOpen((prev) => {
      if (!prev.has(documentId)) return prev;
      api
        .documentChunks(documentId)
        .then((dc) => setOpen((cur) => new Map(cur).set(documentId, dc)))
        .catch(() => {});
      return prev;
    });
  }, []);

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

  // No confirmation: switching watching off changes nothing that was already learned, and it
  // switches back on with the same click.
  async function toggleWatch(doc: ContextDocument) {
    const next = doc.watching === false;
    setDocs((prev) =>
      prev ? prev.map((d) => (d.id === doc.id ? { ...d, watching: next } : d)) : prev,
    );
    try {
      await api.watchDocument(doc.id, next);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      load();
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

        <h2 className="sectionTitle">Queue</h2>
        <IngestQueueCard
          onChanged={() => {
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

        <WatchedFolders
          onChanged={() => {
            load();
            onChanged();
          }}
        />

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
                {/* Stated, not warned about. A pipeline that deletes recordings after upload
                    makes this the normal state for a whole folder, so it reads as a fact next
                    to the kind rather than as something gone wrong. */}
                {d.missingAt && <span className="kindTag kindTagMuted">file missing</span>}
                {d.watchable && d.watching === false && (
                  <span className="kindTag kindTagMuted">not watching</span>
                )}
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
                {/* Only where there is a file to watch. An upload or a web page carries the
                    column's default rather than an answer, so offering the control would be
                    offering a switch that does nothing. */}
                {d.watchable && (
                  <button type="button" className="btn" onClick={() => toggleWatch(d)}>
                    {d.watching === false ? "Watch" : "Stop watching"}
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
              {timed && (d.speakers?.speakers.length ?? 0) > 0 && (
                <SpeakerPanel
                  doc={d}
                  canPlay={!d.path.startsWith("upload://")}
                  onRoster={onRoster}
                  onError={setError}
                />
              )}
              {chunks && (
                <div className="chunkList">
                  {chunks.chunks.map((c) => (
                    <div key={c.id} className="statement">
                      {timed && c.headingPath ? (
                        <div className="chunkTime">
                          <Clock size={12} strokeWidth={1.75} />
                          {/* "12:30 - 14:28, Alice": the range never contains a comma, so
                              the first ", " splits time from speaker reliably. */}
                          {c.headingPath.includes(", ") ? (
                            <>
                              {c.headingPath.slice(0, c.headingPath.indexOf(", "))}
                              <span className="chunkSpeaker">
                                {c.headingPath.slice(c.headingPath.indexOf(", ") + 2)}
                              </span>
                            </>
                          ) : (
                            c.headingPath
                          )}
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
