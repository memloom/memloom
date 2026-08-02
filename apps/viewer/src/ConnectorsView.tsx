import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type NotionListedPage,
  type NotionScope,
  type NotionStatus,
  type NotionSyncEvent,
  type NotionSyncResult,
} from "./api";
import { toastDone, toastFailed, toastSaid } from "./toast";

// Connectors: outside sources that sync into the same recall as memories and files. Notion
// is the first (and only) one. The daemon holds the token and owns the sync watermarks; this
// view only reads status, edits the selection, and streams a sync's progress.

const POLL_MS = 1_500;

const LEVEL_ICON = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
} as const;

type LogLevel = keyof typeof LEVEL_ICON;

interface LogLine {
  level: LogLevel;
  message: string;
}

function formatWhen(iso: string): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "";
}

// One display row of the listing tree: the item, its indent depth, and any database
// row-pages folded into it (0 for pages).
interface ListingRow {
  item: NotionListedPage;
  depth: number;
  rows: number;
}

// The listing flattened for display. Children indent under their parent; database row-pages
// are not rendered on their own (syncing the database captures them), they only bump their
// data source's row count. Missing parentId/parentType fields degrade to a flat list.
function flattenListing(listing: NotionListedPage[]): ListingRow[] {
  const byId = new Map(listing.map((i) => [i.id, i]));
  const isRow = (item: NotionListedPage) =>
    item.parentType === "data_source" && item.parentId !== null && byId.has(item.parentId);
  const rowCounts = new Map<string, number>();
  const children = new Map<string, NotionListedPage[]>();
  const roots: NotionListedPage[] = [];
  for (const item of listing) {
    if (isRow(item)) {
      rowCounts.set(item.parentId as string, (rowCounts.get(item.parentId as string) ?? 0) + 1);
      continue;
    }
    const parent = item.parentId ? byId.get(item.parentId) : undefined;
    if (parent && !isRow(parent)) {
      const list = children.get(parent.id);
      if (list) list.push(item);
      else children.set(parent.id, [item]);
    } else {
      roots.push(item);
    }
  }
  const out: ListingRow[] = [];
  const seen = new Set<string>();
  const walk = (item: NotionListedPage, depth: number) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    out.push({ item, depth, rows: rowCounts.get(item.id) ?? 0 });
    for (const child of children.get(item.id) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return out;
}

function kindLabel(row: ListingRow): string {
  if (row.item.object === "data_source") {
    return row.rows > 0 ? `database, ${row.rows} row${row.rows === 1 ? "" : "s"}` : "database";
  }
  return "page";
}

function syncLevel(outcome: NotionSyncEvent["outcome"]): LogLevel {
  switch (outcome) {
    case "added":
    case "updated":
      return "success";
    case "waiting":
      return "warning";
    case "error":
      return "error";
    default:
      return "info";
  }
}

function incrementalNote(e: NotionSyncEvent): string {
  return e.refetched !== undefined && e.sections !== undefined
    ? `, refetched ${e.refetched} of ${e.sections} sections`
    : "";
}

function truncNote(e: NotionSyncEvent): string {
  return e.truncated ? "; over the block cap, the newest content was not synced" : "";
}

function syncMessage(e: NotionSyncEvent): string {
  const label = `[${e.index}/${e.total}] ${e.title}`;
  switch (e.outcome) {
    case "waiting":
      return "another sync is already running; waiting for it, then running yours";
    case "fetching":
      return e.chunks > 0
        ? `${label}: still fetching (${e.chunks} blocks so far)`
        : `${label}: fetching from Notion`;
    case "fresh":
      return `${label}: no edits since last sync`;
    case "would-sync":
      return `${label}: would sync`;
    case "unchanged":
      return `${label}: fetched, content identical (${e.chunks} chunks kept${incrementalNote(e)})${truncNote(e)}`;
    case "added":
      return `${label}: synced (${e.chunks} chunks)${truncNote(e)}`;
    case "updated":
      return `${label}: updated (${e.chunks} chunks${incrementalNote(e)})${truncNote(e)}`;
    case "error":
      return `${label}: failed: ${e.error}`;
  }
}

function summaryLine(result: NotionSyncResult): string {
  if (result.dryRun) {
    return `dry run over ${result.items} selected item${result.items === 1 ? "" : "s"}; nothing written.`;
  }
  const parts = [
    result.added > 0 ? `${result.added} new` : "",
    result.updated > 0 ? `${result.updated} updated` : "",
    result.unchanged > 0 ? `${result.unchanged} unchanged` : "",
    result.fresh > 0 ? `${result.fresh} already fresh` : "",
    result.errors > 0 ? `${result.errors} failed` : "",
  ].filter(Boolean);
  return `${result.items} item${result.items === 1 ? "" : "s"}: ${parts.join(", ") || "nothing to do"}`;
}

export function ConnectorsView({ onChanged }: { onChanged: () => void }) {
  return (
    <div className="panel">
      <div className="panelInner">
        <h2 className="sectionTitle">Connectors</h2>
        <NotionCard onChanged={onChanged} />
      </div>
    </div>
  );
}

function NotionCard({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<NotionStatus | null>(null);
  const [pages, setPages] = useState<NotionListedPage[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loadingPages, setLoadingPages] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [disconnectArmed, setDisconnectArmed] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [summary, setSummary] = useState<NotionSyncResult | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const s = await api.notionStatus();
      setStatus(s);
      return s;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, []);

  // Refetch the listing and reset the checkboxes to the server's saved selection.
  const loadPages = useCallback(async () => {
    setLoadingPages(true);
    setSaved(false);
    setError(null);
    try {
      const list = await api.notionPages();
      setPages(list);
      setSelected(new Set(list.filter((p) => p.selected).map((p) => p.id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingPages(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus().then((s) => {
      if (s?.tokenPresent) void loadPages();
    });
  }, [loadStatus, loadPages]);

  // Keep the "syncing now" indicator and counts fresh while any sync (ours or the daemon
  // poll's) is running; the daemon store is the source of truth.
  const anyRunning = syncing || (status?.syncing ?? false);
  useEffect(() => {
    if (!anyRunning) return;
    const interval = setInterval(() => void loadStatus(), POLL_MS);
    return () => clearInterval(interval);
  }, [anyRunning, loadStatus]);

  // Keep the newest log line in view as the stream appends.
  // biome-ignore lint/correctness/useExhaustiveDependencies: log is the scroll trigger, not an input
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  function toggle(id: string) {
    setSaved(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    if (!pages || selected.size === 0) return;
    setSaving(true);
    setError(null);
    try {
      const byId = new Map(pages.map((p) => [p.id, p]));
      const items = [...selected]
        .map((id) => byId.get(id))
        .filter((p): p is NotionListedPage => p !== undefined)
        .map((p) => ({ id: p.id, object: p.object, title: p.title }));
      const scope: NotionScope = { items };
      await api.setNotionScope(scope);
      setSaved(true);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function disconnect() {
    if (!disconnectArmed) {
      setDisconnectArmed(true);
      return;
    }
    setDisconnectArmed(false);
    setError(null);
    try {
      await api.setNotionScope(null);
      setSaved(false);
      setSummary(null);
      setLog([]);
      await loadStatus();
      await loadPages();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function runSync() {
    setSyncing(true);
    setError(null);
    setSummary(null);
    setLog([]);
    try {
      const result = await api.notionSync({ wait: true }, (e) => {
        setLog((prev) => [...prev, { level: syncLevel(e.outcome), message: syncMessage(e) }]);
      });
      setSummary(result);
      // The log below says what happened per page. This says whether it worked, from anywhere on
      // the page, because a sync can take a while and the eye wanders.
      if (result.errors > 0) toastFailed(`sync finished with problems. ${summaryLine(result)}`);
      else if (result.dryRun) toastSaid(summaryLine(result));
      else toastDone(`Notion synced. ${summaryLine(result)}`);
      await loadStatus();
      await loadPages();
      onChanged();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toastFailed(`sync failed: ${message}`);
    } finally {
      setSyncing(false);
    }
  }

  const tree = pages ? flattenListing(pages) : [];
  const scopeItems = status?.scope?.items ?? null;

  return (
    <div className="card">
      {error && <div className="notice noticeError">{error}</div>}

      <div className="docHead">
        <span className="docTitle">Notion</span>
        {status?.syncing && (
          <span className="notionSyncing">
            <Loader2 size={13} strokeWidth={1.75} className="spinIcon" />
            syncing now
          </span>
        )}
        {status && (
          <span className="docMeta">
            {status.documents} document{status.documents === 1 ? "" : "s"}, {status.chunks} chunks
          </span>
        )}
      </div>

      {!status ? (
        !error && <div className="spin">loading…</div>
      ) : !status.tokenPresent ? (
        <div className="notionSetup">
          <p>The daemon needs a Notion token before this connector works.</p>
          <ol>
            <li>
              Create an internal integration at <code>notion.so/profile/integrations</code>.
            </li>
            <li>Open each page's menu, Connections, and add the integration.</li>
            <li>
              Set <code>NOTION_TOKEN</code> in the daemon environment (
              <code>~/.memloom/config.env</code>).
            </li>
            <li>Restart the daemon.</li>
          </ol>
        </div>
      ) : (
        <>
          <div className="notionStatusLines">
            <div>
              {scopeItems === null || scopeItems.length === 0
                ? "No pages selected yet."
                : `${scopeItems.length} selected: ${scopeItems.map((i) => i.title).join(", ")}`}
            </div>
            <div className="docMeta notionStatusMeta">
              last sync {status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : "never"}
            </div>
            {status.lastSyncError && (
              <div className="notionStatusError">last sync failed: {status.lastSyncError}</div>
            )}
          </div>

          <div className="notionPickerHead">
            <span className="cardLabel">
              pages visible to the integration{pages ? `; ${pages.length}` : ""}
            </span>
            <button
              type="button"
              className="btn btnGhost"
              disabled={loadingPages}
              onClick={() => void loadPages()}
            >
              {loadingPages ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          {!pages ? (
            <div className="spin">loading…</div>
          ) : pages.length === 0 ? (
            <p style={{ color: "var(--text-faint)" }}>
              The integration cannot see any pages yet. Share pages with it in Notion, then refresh.
              A just-shared page can take a minute to appear.
            </p>
          ) : (
            <div className="notionTree">
              {tree.map((row) => (
                <label
                  key={row.item.id}
                  className="notionRow"
                  style={{ paddingLeft: 8 + row.depth * 18 }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(row.item.id)}
                    onChange={() => toggle(row.item.id)}
                  />
                  <span className="notionRowTitle">{row.item.title}</span>
                  <span className="notionRowKind">{kindLabel(row)}</span>
                  <span className="notionRowMeta">edited {formatWhen(row.item.lastEdited)}</span>
                </label>
              ))}
            </div>
          )}

          <div className="actions">
            <button
              type="button"
              className="btn btnPrimary"
              disabled={saving || selected.size === 0}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save selection"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={syncing || status.syncing}
              onClick={() => void runSync()}
            >
              {syncing || status.syncing ? "Syncing…" : "Sync now"}
            </button>
            <button
              type="button"
              className={`btn btnDanger ${disconnectArmed ? "btnDangerArmed" : ""}`}
              onBlur={() => setDisconnectArmed(false)}
              onClick={() => void disconnect()}
            >
              {disconnectArmed ? "Confirm disconnect" : "Disconnect"}
            </button>
          </div>

          {saved && (
            <div className="resultOutcome outcome-added">selection saved; the daemon syncs it.</div>
          )}

          {(log.length > 0 || summary) && (
            <div className="sessionBody" ref={logRef}>
              {log.map((line, i) => {
                const Icon = LEVEL_ICON[line.level];
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: append-only log, index is stable
                  <div key={i} className={`eventRow level-${line.level}`}>
                    <Icon size={12} strokeWidth={1.75} className="levelIcon" />
                    <span className="eventMessage">{line.message}</span>
                  </div>
                );
              })}
            </div>
          )}

          {summary && (
            <div
              className={`resultOutcome ${summary.errors > 0 ? "outcome-conflict" : "outcome-added"}`}
            >
              {summaryLine(summary)}
              {summary.truncated > 0 &&
                ` ${summary.truncated} item${summary.truncated === 1 ? " was" : "s were"} truncated at the block cap.`}
            </div>
          )}
        </>
      )}
    </div>
  );
}
