import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type ContextProgress,
  fileToBase64,
  type LinkErrorCode,
  LinkIngestError,
  type Memory,
  type QueueSnapshot,
  type SaveResult,
} from "./api";
import { cachedData, refetch } from "./prefetch";

// Shared action cards: save a memory, recall, ingest a file, add a link. Used by the Console
// (save + recall, unfiltered), the Memories tab (save + memory-only recall), and the
// Documents tab (add file, add link, context-only recall).

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
          {result.outcome === "merged" && `already known, merged into ${result.id}`}
          {result.outcome === "versioned" && `new version v${result.version ?? "?"}`}
          {result.outcome === "conflict" && (
            <>
              contradiction detected, both kept.
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
            similarity {(m.similarity ?? 0).toFixed(2)}; saved{" "}
            {new Date(m.createdAt).toLocaleString()}
            {m.source && (
              <>
                {"; from "}
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

// The formats the daemon transcribes. Kept here so the add card can choose the streaming
// route from the path alone, before the daemon has looked at anything.
const MEDIA_EXTENSIONS = [
  ".mp3",
  ".m4a",
  ".wav",
  ".flac",
  ".ogg",
  ".opus",
  ".aac",
  ".wma",
  ".mp4",
  ".mkv",
  ".mov",
  ".webm",
  ".avi",
  ".m4v",
];
// Media is uploadable now because an uploaded recording is queued rather than transcribed
// inside the request: the queue reports its progress, so the silent multi-minute wait that
// kept media off this list is gone. Linking is still better for a large file, since an
// upload is a one-time snapshot that cannot be re-scanned from disk later.
const SUPPORTED_EXTENSIONS = [".md", ".markdown", ".txt", ".pdf", ...MEDIA_EXTENSIONS];
const MAX_UPLOAD_FILES = 200;

/**
 * Mirrors the daemon's /context/upload bodyLimit (~512 MB of real file before base64).
 * Checked BEFORE encoding, not just to save a round trip: base64 of a file much past this
 * needs a JavaScript string longer than V8 allows at all, so oversized files die in
 * fileToBase64 with a bare "Invalid string length" and the daemon's own friendly 413 is
 * never even reached. Keep in sync with packages/server (maxSize: 700 MB of base64).
 */
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

function isSupported(name: string): boolean {
  const lower = name.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function isMedia(target: string): boolean {
  const lower = target.toLowerCase();
  return MEDIA_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function fileName(target: string): string {
  return target.split(/[\\/]/).pop() || target;
}

/**
 * Whether this target is worth streaming. Media transcribes for minutes, and a folder can
 * hold media or simply hold a lot, so both report as they go. Guessing wrong is harmless
 * either way: the stream handles a lone text file, and the plain add handles a folder.
 */
function wantsProgress(target: string): boolean {
  return isMedia(target) || !fileName(target).includes(".");
}

/** Seconds as "12:30", or "1:12:30" past an hour: the same clock the transcript cites by. */
function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  return `${hours > 0 ? `${hours}:` : ""}${mm}:${String(rest).padStart(2, "0")}`;
}

/** Bytes as "1.4 GB": the hashing stage counts a file, not a clock. */
function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/**
 * One progress event as a line of copy.
 *
 * Every stage is named, including the ones that cannot report a percentage. On a large
 * recording the work before the first transcribed word runs for minutes, and an unnamed
 * stage there reads as a hang rather than as progress.
 */
function describeStage(event: ContextProgress): { line: string; fraction: number | null } {
  if (event.stage === "hashing") {
    // Bytes, not chunks: this stage is reading the file, and saying "3% of 4.1 GB" tells
    // the user both what is happening and why it is not instant.
    return {
      line: event.total > 0 ? `reading the file; ${bytes(event.total)}` : "reading the file",
      fraction: event.total > 0 ? event.done / event.total : null,
    };
  }
  if (event.stage === "waiting") {
    // The queue is holding a file that is still growing rather than reading half of it.
    // Naming this matters more than most stages: nothing is happening, and an unlabelled
    // pause here looks exactly like a stall.
    return {
      line:
        event.done > 0
          ? `waiting for the file to finish copying; ${event.done}s`
          : "waiting for the file to finish copying",
      fraction: null,
    };
  }
  if (event.stage === "decoding") return { line: "extracting the audio track", fraction: null };
  if (event.stage === "detecting") {
    return {
      line: `finding speech in ${clock(event.audioSeconds)}`,
      fraction: event.total > 0 ? event.done / event.total : null,
    };
  }
  if (event.stage === "loading") return { line: "loading the speech model", fraction: null };
  if (event.stage === "diarizing") {
    return {
      line: "telling the voices apart",
      fraction: event.total > 0 ? event.done / event.total : null,
    };
  }
  if (event.stage === "checking") return { line: "checking the transcript", fraction: null };
  if (event.stage === "repairing") {
    return { line: `re-reading a rough stretch at ${clock(event.seconds)}`, fraction: null };
  }
  if (event.stage === "transcribing") {
    return {
      line: `transcribing ${clock(event.seconds)} of ${clock(event.audioSeconds)}`,
      fraction: event.total > 0 ? event.done / event.total : null,
    };
  }
  return { line: event.stage, fraction: null };
}

export function AddFileCard({ onAdded }: { onAdded: () => void }) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // With auto-index on, "run index" would be stale advice: extraction is already queued.
  const [autoIndexOn, setAutoIndexOn] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const indexHint = autoIndexOn
    ? "Entities are being extracted in the background."
    : "Run index to extract entities.";

  useEffect(() => {
    api
      .autoIndex()
      .then((r) => setAutoIndexOn(r.enabled))
      .catch(() => {});
  }, []);

  // Path-based ingest (link buttons + the text field): the daemon reads its own disk, so
  // the document keeps a real path: "open file" works, re-adding detects changes, and
  // the planned file-sync watcher can follow it. Upload (below) is the snapshot flow.
  async function ingest(target: string) {
    // A recording, or a folder that may hold one, goes to the queue like any batch: one
    // path or ten is the same flow, so a single linked video does not silently take a
    // different (and blocking) road than two would. Text and PDFs answer inline before a
    // progress row would even render.
    if (wantsProgress(target)) return ingestMany([target]);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api.contextAdd(target);
      const absorbedNote = r.absorbed
        ? ` Removed ${r.absorbed} duplicate ${r.absorbed === 1 ? "upload" : "uploads"}.`
        : "";
      setNotice(
        r.documents !== undefined
          ? `ingested ${r.documents} ${r.documents === 1 ? "file" : "files"}` +
              `${r.unchanged ? ` (${r.unchanged} unchanged)` : ""}; ${r.chunks} chunks. ` +
              indexHint +
              absorbedNote
          : r.outcome === "converted"
            ? r.rechunked
              ? `linked "${r.title}"; replaced the uploaded snapshot and re-chunked; ${r.chunks} chunks. ${indexHint}${absorbedNote}`
              : `linked "${r.title}"; replaced the uploaded snapshot, chunks and entities kept.${absorbedNote}`
            : r.outcome === "unchanged"
              ? `"${r.title}" is unchanged, nothing to do.${absorbedNote}`
              : `${r.outcome} "${r.title}"; ${r.chunks} chunks. ${indexHint}${absorbedNote}`,
      );
      setPath("");
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function ingestMany(targets: string[]) {
    // Anything slow goes to the queue rather than running inside this request. That is what
    // lets you keep adding while one is transcribing, and it is also the only safe answer:
    // each recognizer holds about 1.1 GB, so two concurrent transcriptions would double the
    // memory for very little speed, given ONNX Runtime already keeps four cores busy inside
    // a single decode. The queue deliberately runs one at a time.
    if (targets.some(wantsProgress)) {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const result = await api.queueAdd(targets);
        setNotice(
          result.added === 0
            ? "already queued"
            : `queued ${result.added} ${result.added === 1 ? "file" : "files"}; progress is below`,
        );
        setPath("");
        onAdded();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
      return;
    }
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
      `linked ${files} ${files === 1 ? "file" : "files"}` +
        `${unchanged ? ` (${unchanged} unchanged)` : ""}; ${chunks} chunks. ` +
        indexHint,
    );
    if (failures.length > 0) setError(failures.join("; "));
    setPath("");
    setBusy(false);
    onAdded();
  }

  // The OS-native dialog on this machine (the daemon IS local): the only dialog that can
  // return absolute paths. Headless systems answer 501. Point at the alternatives.
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
      setError("no file dialog on this system: type a path above, or use Upload");
    }
  }

  // Snapshot ingest: the browser's own dialog yields bytes, never paths, so uploaded
  // documents cannot be opened from disk or change-tracked. Quick adds only.
  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    const all = Array.from(files);
    const supported = all.filter((f) => isSupported(f.name)).slice(0, MAX_UPLOAD_FILES);
    const skipped = all.length - supported.length;
    if (supported.length === 0) {
      setError(`no supported files picked (${SUPPORTED_EXTENSIONS.join(", ")})`);
      return;
    }
    const failures: string[] = [];
    const fits = supported.filter((f) => {
      if (f.size <= MAX_UPLOAD_BYTES) return true;
      failures.push(
        `${f.name} is ${bytes(f.size)}, over the ~512 MB upload limit. ` +
          "Use Link file instead: the daemon reads it from disk, nothing is copied, " +
          "and big recordings transcribe with progress either way.",
      );
      return false;
    });
    if (fits.length === 0) {
      setNotice(null);
      setError(failures.join("; "));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    let added = 0;
    let unchanged = 0;
    let chunks = 0;
    let existsNote: string | null = null;
    for (const file of fits) {
      try {
        const r = await api.contextUpload(file.name, await fileToBase64(file));
        chunks += r.chunks;
        if (r.outcome === "unchanged") unchanged += 1;
        else if (r.outcome === "exists") {
          // Nothing was created: the content or filename already lives in the store,
          // usually as a linked file (the stronger identity: it refreshes from disk).
          unchanged += 1;
          existsNote =
            r.path && !r.path.startsWith("upload://")
              ? `"${r.title}" is already in your context as a linked file (${r.path}); re-link it to refresh from disk.`
              : `"${r.title}" is already in your context, nothing to do.`;
        } else added += 1;
      } catch (err) {
        failures.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // A summary only when something actually happened: "uploaded 0 files" next to a red
    // failure reads as the system contradicting itself.
    if (added + unchanged > 0) {
      setNotice(
        fits.length === 1 && existsNote
          ? existsNote
          : `uploaded ${added} ${added === 1 ? "file" : "files"}` +
              `${unchanged ? ` (${unchanged} already here)` : ""}` +
              `${skipped ? ` (${skipped} unsupported skipped)` : ""}; ${chunks} chunks. ` +
              indexHint,
      );
    }
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
      {/* The composer layout: a full-width path input, then an action bar below it. */}
      <form
        className="addFileForm"
        onSubmit={(e) => {
          e.preventDefault();
          const target = path.trim();
          if (!target) return;
          // A pasted address would fail here as a missing file. Web pages have their own
          // card, and their own failure modes, so point at it instead of guessing.
          if (/^https?:\/\//i.test(target)) {
            setError("that looks like a web page; add it under Add a link below");
            return;
          }
          void ingest(target);
        }}
      >
        <input
          type="text"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="Path to a file (.md, .txt, .pdf, .mp3, .mp4) or a folder on this machine…"
        />
        <div className="addFileBar">
          <div className="addFileBarGroup">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void pickNative("file")}
            >
              Link file…
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void pickNative("folder")}
            >
              Link folder…
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
            >
              Upload…
            </button>
          </div>
          {/* No Stop here anymore: a recording lives in the queue below, where its own
              row carries Cancel. This button only ever covers the fast inline formats. */}
          <button type="submit" className="btn btnPrimary" disabled={busy || path.trim() === ""}>
            {busy ? "Ingesting…" : "Add"}
          </button>
        </div>
      </form>
      <p className="addFileHint">
        Linked files keep their place on disk: openable, re-scanned on add, and ready for file sync.
        Uploads are one-time snapshots from the browser dialog; linking the same file later replaces
        its snapshot, and an upload never duplicates a linked file. Recordings are transcribed on
        this machine and cited by timestamp, which takes a few minutes per hour of audio; link them
        rather than uploading them, so you can watch the progress.
      </p>

      {notice && <div className="resultOutcome outcome-added">{notice}</div>}
    </div>
  );
}

/**
 * Why a page was refused, in the reader's terms. The daemon's own message stays underneath
 * as the detail: this line is what to do about it.
 */
function linkAdvice(code: LinkErrorCode | null): string | null {
  switch (code) {
    case "likely_rendered":
      // Print to PDF and not "save page as": the extractor registry reads .md, .txt, .pdf
      // and media, so a saved .html would be refused as an unsupported file type.
      return "This page builds itself in the browser, so what the server sends holds almost no text. Print it to PDF from your browser and add that file instead.";
    case "not_html":
      return "That address points at a file, not a web page. Download it and add it as a file.";
    case "too_large":
      return "That page is over the 10 MB limit.";
    case "too_many_redirects":
      return "The address kept redirecting. Try the page it finally lands on.";
    case "http_error":
      return "The site answered with an error. The page may be gone, it may need a sign-in, or the site may be turning away anything that is not a browser.";
    case "empty":
      return "Nothing readable came back from that address.";
    default:
      return null;
  }
}

export function AddLinkCard({ onAdded }: { onAdded: () => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ advice: string | null; detail: string } | null>(null);

  return (
    <div className="card">
      {failure && (
        <div className="notice noticeError noticeStacked">
          <span>{failure.advice ?? failure.detail}</span>
          {failure.advice && <span className="noticeDetail">{failure.detail}</span>}
        </div>
      )}
      <form
        className="formRow"
        onSubmit={async (e) => {
          e.preventDefault();
          const target = url.trim();
          if (!target) return;
          setBusy(true);
          setFailure(null);
          setNotice(null);
          try {
            const r = await api.contextAddUrl(target);
            setNotice(
              r.outcome === "unchanged"
                ? `"${r.title}" is unchanged, nothing to do.`
                : `${r.outcome} "${r.title}"; ${r.chunks} chunks.`,
            );
            setUrl("");
            onAdded();
          } catch (err) {
            // The daemon's likely_rendered message sends the reader to a browser extension
            // that does not ship yet, so that one code shows the address it settled on.
            setFailure(
              err instanceof LinkIngestError
                ? {
                    advice: linkAdvice(err.code),
                    detail: err.code === "likely_rendered" ? err.url : err.message,
                  }
                : { advice: null, detail: err instanceof Error ? err.message : String(err) },
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…"
        />
        <button type="submit" className="btn btnPrimary" disabled={busy || url.trim() === ""}>
          {busy ? "Reading…" : "Add link"}
        </button>
      </form>
      <p className="addFileHint">
        memloom fetches the page and pulls the article out of it here, on this machine: no reader
        service, no crawler, nothing about the page leaves. Adding the same link again refreshes it.
      </p>

      {notice && <div className="resultOutcome outcome-added">{notice}</div>}
    </div>
  );
}

/**
 * The ingest queue: what is waiting, what is running, what stopped and why.
 *
 * Rendered as its own section rather than folded into the add card, because the queue
 * outlives any one add: it survives a daemon restart, and you can keep adding to it while
 * something is already transcribing.
 *
 * Polled rather than streamed. It changes about once per decode chunk, so a one-second poll
 * costs nothing and avoids a second NDJSON reader with its own reconnect behaviour.
 */
export function IngestQueueCard({ onChanged }: { onChanged: () => void }) {
  // Seeded from the prefetch cache so the queue paints with its rows on the first frame;
  // the 1-second poll below is always a fresh read and keeps the cache current for the
  // next tab visit.
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(() =>
    cachedData<QueueSnapshot>("queue"),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Held so a finished item can refresh the document list exactly once, rather than on
  // every poll while it sits there in its done state.
  const settled = useRef(0);

  const load = useCallback(async () => {
    try {
      const next = await refetch("queue", api.queue);
      setSnapshot(next);
      const finished = next.items.filter((i) => i.status === "done").length;
      if (finished !== settled.current) {
        settled.current = finished;
        onChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [onChanged]);

  useEffect(() => {
    void load();
    const timer = setInterval(load, 1000);
    return () => clearInterval(timer);
  }, [load]);

  async function act(id: string, fn: (id: string) => Promise<QueueSnapshot>) {
    setBusy(id);
    setError(null);
    try {
      setSnapshot(await fn(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const items = snapshot?.items ?? [];
  if (items.length === 0) {
    // The Queue heading above this card never leaves the page, and a heading with
    // nothing under it reads as a rendering bug. The empty state holds the space and
    // says what will appear in it.
    return (
      <div className="card">
        {error && <div className="notice noticeError">{error}</div>}
        <div className="queueEmpty">
          {snapshot === null
            ? "loading…"
            : "Nothing queued. Recordings you link or upload line up here and process one at a time."}
        </div>
      </div>
    );
  }

  const waiting = items.filter((i) => i.status === "queued").length;
  return (
    <div className="card">
      {error && <div className="notice noticeError">{error}</div>}
      <div className="queueHead">
        <span>
          {waiting > 0 ? `${waiting} waiting` : snapshot?.running ? "working" : "nothing waiting"}
        </span>
        {items.some((i) => i.status !== "queued" && i.status !== "running") && (
          <button
            type="button"
            className="btn btnGhost"
            onClick={async () => {
              await api.queueClear();
              await load();
            }}
          >
            Clear finished
          </button>
        )}
      </div>
      {items.map((item) => {
        const progress =
          item.status === "running" && item.stage
            ? describeStage({
                path: item.path,
                stage: item.stage,
                done: item.done ?? 0,
                total: item.total ?? 0,
                seconds: item.seconds ?? 0,
                audioSeconds: item.audioSeconds ?? 0,
              })
            : null;
        return (
          <div key={item.id} className={`queueRow queueRow-${item.status}`}>
            <div className="queueRowHead">
              <span className="queueName">{fileName(item.path)}</span>
              <span className="queueStatus">
                {item.status === "running" && progress
                  ? progress.line +
                    (progress.fraction === null ? "" : `; ${Math.round(progress.fraction * 100)}%`)
                  : item.status === "done"
                    ? `${item.outcome ?? "done"}; ${item.chunks ?? 0} chunks`
                    : item.status === "failed"
                      ? (item.error ?? "failed")
                      : item.status}
              </span>
            </div>
            {item.status === "running" && (
              <div className="queueBar">
                <div
                  className={
                    progress?.fraction === null ? "queueBarFill queueBarBusy" : "queueBarFill"
                  }
                  style={
                    progress?.fraction == null
                      ? undefined
                      : { width: `${progress.fraction * 100}%` }
                  }
                />
              </div>
            )}
            <div className="queueActions">
              {(item.status === "queued" || item.status === "running") && (
                <button
                  type="button"
                  className="btn btnGhost"
                  disabled={busy === item.id}
                  onClick={() => act(item.id, api.queueCancel)}
                >
                  Cancel
                </button>
              )}
              {(item.status === "cancelled" || item.status === "failed") && (
                <button
                  type="button"
                  className="btn btnGhost"
                  disabled={busy === item.id}
                  onClick={() => act(item.id, api.queueResume)}
                >
                  Resume
                </button>
              )}
              {item.status !== "running" && (
                <button
                  type="button"
                  className="btn btnGhost"
                  disabled={busy === item.id}
                  onClick={() => act(item.id, api.queueRemove)}
                >
                  Remove
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
