import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Info,
  Loader2,
  Trash2,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type IndexEventLevel, type IndexRun, type IndexRunEvent } from "./api";

// Console: exercise the engine by hand (save, recall, index) without leaving the viewer.
// Indexing history is persistent and session-grouped (a production-proven memory_index_runs
// pattern): the engine writes a run row + per-item events to the store, so the log
// survives tab switches and page reloads, and CLI runs show up here too. While a run is
// live the view polls the store. The DB is the single source of truth, no client state.

const LEVEL_ICON: Record<IndexEventLevel, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

const POLL_MS = 1_500;

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function runSummary(run: IndexRun): string {
  if (run.status === "running") {
    const done = run.memoriesIndexed + run.chunksIndexed + run.itemsFailed;
    return `indexing ${done}/${run.batchSize} items…`;
  }
  const parts: string[] = [];
  if (run.memoriesIndexed > 0)
    parts.push(`${run.memoriesIndexed} ${run.memoriesIndexed === 1 ? "memory" : "memories"}`);
  if (run.chunksIndexed > 0) parts.push(`${run.chunksIndexed} chunks`);
  const indexed = parts.length > 0 ? `${parts.join(", ")} indexed` : "nothing indexed";
  const failed = run.itemsFailed > 0 ? `, ${run.itemsFailed} failed` : "";
  const prefix =
    run.status === "interrupted" ? "interrupted: " : run.trigger === "rebuild" ? "rebuild: " : "";
  return `${prefix}${indexed}${failed} · +${run.entitiesLinked} entities, +${run.relationsCreated} relations`;
}

function runLevel(run: IndexRun): IndexEventLevel {
  if (run.status === "success") return "success";
  if (run.status === "error") return "error";
  if (run.status === "running") return "info";
  return "warning"; // warning | interrupted
}

// One collapsible session. Events load lazily on expand; the parent refetches them while
// the run is live. The body autoscrolls so the newest line stays in view.
function SessionRow({
  run,
  expanded,
  events,
  onToggle,
  onDelete,
}: {
  run: IndexRun;
  expanded: boolean;
  events: IndexRunEvent[] | undefined;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const [deleteArmed, setDeleteArmed] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const running = run.status === "running";

  // Keep the newest line in view while the run streams new events in.
  useEffect(() => {
    if (!running || !events?.length) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [running, events]);

  const level = runLevel(run);
  const Icon = LEVEL_ICON[level];
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <div className="session">
      <div className={`sessionHeader level-${level}`}>
        <button type="button" className="sessionToggle" onClick={onToggle} aria-expanded={expanded}>
          <Chevron size={13} strokeWidth={1.75} className="sessionChevron" />
          {running ? (
            <Loader2 size={13} strokeWidth={1.75} className="spinIcon" />
          ) : (
            <Icon size={13} strokeWidth={1.75} className="levelIcon" />
          )}
          <span className="sessionSummary">{runSummary(run)}</span>
        </button>
        <span className="sessionMeta">
          {run.batchSize} {run.batchSize === 1 ? "item" : "items"}
        </span>
        <span className="sessionMeta" title={new Date(run.startedAt).toLocaleString()}>
          {relativeTime(run.startedAt)}
        </span>
        <button
          type="button"
          className={`sessionDelete ${deleteArmed ? "sessionDeleteArmed" : ""}`}
          onBlur={() => setDeleteArmed(false)}
          onClick={() => {
            if (!deleteArmed) {
              setDeleteArmed(true);
              return;
            }
            setDeleteArmed(false);
            onDelete();
          }}
          title={deleteArmed ? "Click again to delete this session" : "Delete this session"}
        >
          {deleteArmed ? "confirm" : <Trash2 size={13} strokeWidth={1.75} />}
        </button>
      </div>
      {expanded && (
        <div className="sessionBody" ref={bodyRef}>
          {!events ? (
            <div className="sessionEmpty">loading…</div>
          ) : events.length === 0 ? (
            <div className="sessionEmpty">no per-item events recorded</div>
          ) : (
            events.map((e) => {
              const EventIcon = LEVEL_ICON[e.level];
              return (
                <div key={e.id} className={`eventRow level-${e.level}`}>
                  <EventIcon size={12} strokeWidth={1.75} className="levelIcon" />
                  <span className="eventMessage">{e.message}</span>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

export function ConsoleView({ onChanged }: { onChanged: () => void }) {
  const [indexing, setIndexing] = useState(false);
  const [rebuildArmed, setRebuildArmed] = useState(false);
  const [clearArmed, setClearArmed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [runs, setRuns] = useState<IndexRun[] | null>(null);
  const [eventsByRun, setEventsByRun] = useState<Record<string, IndexRunEvent[]>>({});
  // Auto-index toggle state; null until loaded, unavailable in offline mode.
  const [autoIdx, setAutoIdx] = useState<{ enabled: boolean; available: boolean } | null>(null);

  useEffect(() => {
    api
      .autoIndex()
      .then(setAutoIdx)
      .catch(() => setAutoIdx(null));
  }, []);

  async function toggleAutoIndex() {
    if (!autoIdx?.available) return;
    const next = !autoIdx.enabled;
    setAutoIdx({ ...autoIdx, enabled: next }); // optimistic; revert on failure
    try {
      await api.setAutoIndex(next);
    } catch (err) {
      setAutoIdx({ ...autoIdx });
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  // Explicit expand/collapse choices; the newest run is expanded unless overridden.
  const [expandOverride, setExpandOverride] = useState<Record<string, boolean>>({});

  const newestRunId = runs?.[0]?.id ?? null;
  const isExpanded = useCallback(
    (runId: string) => expandOverride[runId] ?? runId === newestRunId,
    [expandOverride, newestRunId],
  );

  const loadEvents = useCallback(async (runId: string) => {
    const events = await api.runEvents(runId).catch(() => null);
    if (events) setEventsByRun((prev) => ({ ...prev, [runId]: events }));
  }, []);

  // One refresh: the runs list, plus the events of every expanded session. The store is
  // the source of truth, so this is also what keeps a live run's log growing.
  const refreshSessions = useCallback(async () => {
    const list = await api.indexRuns().catch(() => null);
    if (!list) return;
    setRuns(list);
    const newest = list[0]?.id ?? null;
    await Promise.all(
      list
        .filter((run) => expandOverride[run.id] ?? run.id === newest)
        .map((run) => loadEvents(run.id)),
    );
  }, [expandOverride, loadEvents]);

  useEffect(() => {
    void refreshSessions();
    // On mount + steady polling while anything is live: a run started from the CLI (or
    // before a tab switch) keeps logging here with no client state handed over.
  }, [refreshSessions]);

  const anyRunning = indexing || (runs?.some((r) => r.status === "running") ?? false);
  useEffect(() => {
    if (!anyRunning) return;
    const interval = setInterval(() => void refreshSessions(), POLL_MS);
    return () => clearInterval(interval);
  }, [anyRunning, refreshSessions]);

  async function runIndex(rebuild: boolean) {
    setIndexing(true);
    setNotice(null);
    setError(null);
    try {
      const result = rebuild ? await api.reindex() : await api.index();
      if (result.indexed === 0 && result.chunksIndexed === 0) {
        setNotice("everything is already indexed");
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIndexing(false);
      await refreshSessions();
    }
  }

  return (
    <div className="panel">
      <div className="panelInner">
        {error && <div className="notice noticeError">{error}</div>}

        <h2 className="sectionTitle">Index</h2>
        <div className="card">
          <div className="formRow">
            <button
              type="button"
              className="btn"
              disabled={indexing || anyRunning}
              onClick={() => {
                setRebuildArmed(false);
                void runIndex(false);
              }}
            >
              {indexing || anyRunning
                ? "Indexing…"
                : "Extract entities from unindexed memories & context"}
            </button>
            <button
              type="button"
              className={`btn ${rebuildArmed ? "btnDangerArmed" : ""}`}
              disabled={indexing || anyRunning}
              onBlur={() => setRebuildArmed(false)}
              onClick={() => {
                if (!rebuildArmed) {
                  setRebuildArmed(true);
                  return;
                }
                setRebuildArmed(false);
                void runIndex(true);
              }}
            >
              {rebuildArmed ? "Confirm: wipe all entities & re-index" : "Re-index from scratch"}
            </button>
            {autoIdx && (
              <button
                type="button"
                className={`autoIndexToggle ${autoIdx.enabled ? "autoIndexToggleOn" : ""}`}
                disabled={!autoIdx.available}
                title={
                  autoIdx.available
                    ? "Index new memories and files automatically, a few seconds after they land"
                    : "Auto-index needs an LLM; configure OPENROUTER_API_KEY"
                }
                onClick={() => void toggleAutoIndex()}
              >
                auto-index
                <span className="autoIndexTrack">
                  <span className="autoIndexKnob" />
                </span>
                {autoIdx.enabled ? "on" : "off"}
              </button>
            )}
          </div>
          {notice && <div className="sessionEmpty">{notice}</div>}

          {runs && runs.length > 0 && (
            <>
              <div className="sessionListHead">
                <span className="cardLabel">sessions · {runs.length}</span>
                <button
                  type="button"
                  className={`btn btnGhost ${clearArmed ? "btnDangerArmed" : ""}`}
                  onBlur={() => setClearArmed(false)}
                  onClick={async () => {
                    if (!clearArmed) {
                      setClearArmed(true);
                      return;
                    }
                    setClearArmed(false);
                    await api.clearRuns().catch(() => {});
                    setEventsByRun({});
                    await refreshSessions();
                  }}
                >
                  {clearArmed ? "confirm: delete all history" : "clear history"}
                </button>
              </div>
              <div className="sessionList">
                {runs.map((r) => (
                  <SessionRow
                    key={r.id}
                    run={r}
                    expanded={isExpanded(r.id)}
                    events={eventsByRun[r.id]}
                    onToggle={() => {
                      const next = !isExpanded(r.id);
                      setExpandOverride((prev) => ({ ...prev, [r.id]: next }));
                      if (next && !eventsByRun[r.id]) void loadEvents(r.id);
                    }}
                    onDelete={async () => {
                      await api.deleteRun(r.id).catch(() => {});
                      await refreshSessions();
                    }}
                  />
                ))}
              </div>
            </>
          )}
          {runs && runs.length === 0 && (
            <div className="sessionEmpty">
              no indexing activity yet, runs will show here as collapsible sessions
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
