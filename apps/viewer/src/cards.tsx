import { useEffect, useRef, useState } from "react";
import {
  api,
  type ContextFileDone,
  type ContextProgress,
  type ContextStreamEvent,
  fileToBase64,
  type LinkErrorCode,
  LinkIngestError,
  type Memory,
  type SaveResult,
} from "./api";

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

// Upload (the browser dialog) sends bytes over HTTP and cannot report progress, so media
// stays off this list on purpose: a recording uploaded that way would be the silent
// multi-minute wait the streaming path exists to avoid. Link a recording instead.
const SUPPORTED_EXTENSIONS = [".md", ".markdown", ".txt", ".pdf"];
const MAX_UPLOAD_FILES = 200;

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

/** What the card says while one file is being ingested. */
interface IngestStatus {
  path: string;
  line: string;
  /** 0 to 1, or null when the stage has nothing to count. */
  fraction: number | null;
  /** Files finished so far in this run. */
  files: number;
}

// Both stream shapes carry `stage`, and the progress one holds an open set of stage names,
// so the split is a guard rather than a discriminated union.
function isFileDone(event: ContextStreamEvent): event is ContextFileDone {
  return event.stage === "file";
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
  if (event.stage === "decoding") return { line: "extracting the audio track", fraction: null };
  if (event.stage === "detecting") {
    return {
      line: `finding speech in ${clock(event.audioSeconds)}`,
      fraction: event.total > 0 ? event.done / event.total : null,
    };
  }
  if (event.stage === "loading") return { line: "loading the speech model", fraction: null };
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

/** Live progress under the add card: which file, which stage, how far in. */
function IngestStatusBar({ status }: { status: IngestStatus }) {
  const percent = status.fraction === null ? null : Math.round(status.fraction * 100);
  return (
    <div className="ingestStatus">
      <div className="ingestStatusHead">
        <span className="ingestStatusFile">{fileName(status.path)}</span>
        <span className="ingestStatusStage">
          {status.line}
          {percent === null ? "" : `; ${percent}%`}
        </span>
      </div>
      <div className="ingestBar">
        <div
          className={percent === null ? "ingestBarFill ingestBarSlide" : "ingestBarFill"}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
      {status.files > 0 && (
        <div className="ingestStatusCount">
          {status.files} {status.files === 1 ? "file" : "files"} done
        </div>
      )}
    </div>
  );
}

export function AddFileCard({ onAdded }: { onAdded: () => void }) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<IngestStatus | null>(null);
  // With auto-index on, "run index" would be stale advice: extraction is already queued.
  const [autoIndexOn, setAutoIndexOn] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Held so the Stop button can abort a transcription that is already under way.
  const abortRef = useRef<AbortController | null>(null);
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
    // A recording, or a folder that may hold one, goes through the streaming ingest so the
    // card can say what is happening. Text and PDFs answer before a bar would ever move.
    if (wantsProgress(target)) return ingestStreaming([target]);
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

  // One streamed ingest per target. Progress arrives per decode chunk while a recording
  // transcribes, and once more per file when one finishes, so a folder of recordings moves
  // visibly instead of sitting on a spinner for the length of the whole batch.
  async function ingestStreaming(targets: string[]) {
    setBusy(true);
    setError(null);
    setNotice(null);
    setStatus(null);
    // Aborting the request is what stops the work: the daemon watches the request's signal
    // and gives up at the next chunk boundary. Choosing the wrong recording should not cost
    // ten minutes of waiting for a result nobody wants.
    const controller = new AbortController();
    abortRef.current = controller;
    let files = 0;
    let unchanged = 0;
    let chunks = 0;
    const failures: string[] = [];
    try {
      for (const target of targets) {
        const result = await api.contextAddStream(
          target,
          (event) => {
            setStatus((prev) => {
              const done = prev?.files ?? 0;
              if (isFileDone(event)) {
                return {
                  path: event.path,
                  line: `${event.outcome}; ${event.chunks} chunks`,
                  fraction: 1,
                  files: done + 1,
                };
              }
              return { path: event.path, ...describeStage(event), files: done };
            });
          },
          controller.signal,
        );
        files += result.documents;
        unchanged += result.unchanged;
        chunks += result.chunks;
        if (result.errors) failures.push(...result.errors);
      }
      setNotice(
        `ingested ${files} ${files === 1 ? "file" : "files"}` +
          `${unchanged ? ` (${unchanged} unchanged)` : ""}; ${chunks} chunks. ` +
          indexHint,
      );
      if (failures.length > 0) setError(failures.join("; "));
      setPath("");
      onAdded();
    } catch (err) {
      // A cancel is not a failure, and reporting it in red as one reads like something broke.
      if (controller.signal.aborted) {
        setNotice("stopped. Nothing was saved for the file that was still being read.");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      abortRef.current = null;
      setStatus(null);
      setBusy(false);
    }
  }

  async function ingestMany(targets: string[]) {
    if (targets.some(wantsProgress)) return ingestStreaming(targets);
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
    setBusy(true);
    setError(null);
    setNotice(null);
    let added = 0;
    let unchanged = 0;
    let chunks = 0;
    let existsNote: string | null = null;
    const failures: string[] = [];
    for (const file of supported) {
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
    setNotice(
      supported.length === 1 && existsNote
        ? existsNote
        : `uploaded ${added} ${added === 1 ? "file" : "files"}` +
            `${unchanged ? ` (${unchanged} already here)` : ""}` +
            `${skipped ? ` (${skipped} unsupported skipped)` : ""}; ${chunks} chunks. ` +
            indexHint,
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
          {busy && abortRef.current ? (
            <button
              type="button"
              className="btn"
              onClick={() => abortRef.current?.abort()}
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              className="btn btnPrimary"
              disabled={busy || path.trim() === ""}
            >
              {busy ? "Ingesting…" : "Add"}
            </button>
          )}
        </div>
      </form>
      <p className="addFileHint">
        Linked files keep their place on disk: openable, re-scanned on add, and ready for file sync.
        Uploads are one-time snapshots from the browser dialog; linking the same file later replaces
        its snapshot, and an upload never duplicates a linked file. Recordings are transcribed on
        this machine and cited by timestamp, which takes a few minutes per hour of audio; link them
        rather than uploading them, so you can watch the progress.
      </p>

      {status && <IngestStatusBar status={status} />}
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
