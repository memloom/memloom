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
import {
  api,
  type ReconcileAction,
  type ReconcileRun,
  type IndexEventLevel,
  type IndexRun,
  type IndexRunEvent,
} from "./api";
import { cachedData, refetch } from "./prefetch";

// Console: what the engine has been doing to itself. Two histories, both session-grouped and
// both persistent, because the engine writes a run row + per-item detail to the store: the log
// survives tab switches and page reloads, and CLI runs show up here too. While a run is live
// the view polls the store. The DB is the single source of truth, no client state.
//
// Read-only apart from undo. The buttons that START work (index, re-index, auto-index, run
// reconciliation) live in Settings, so this tab answers "what happened" and that one answers "what
// should happen".

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
  return `${prefix}${indexed}${failed}; +${run.entitiesLinked} entities, +${run.relationsCreated} relations`;
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
  const [clearArmed, setClearArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seeded from the prefetch cache so a revisit (or a hover on the tab) renders the
  // session list immediately; the mount refresh below replaces it with a live read.
  const [runs, setRuns] = useState<IndexRun[] | null>(() => cachedData<IndexRun[]>("index-runs"));
  const [eventsByRun, setEventsByRun] = useState<Record<string, IndexRunEvent[]>>({});
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
    // Always a fresh read (this also polls while a run is live), written through the
    // cache so the next tab visit seeds instantly from it.
    const list = await refetch("index-runs", api.indexRuns).catch(() => null);
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

  const anyRunning = runs?.some((r) => r.status === "running") ?? false;
  useEffect(() => {
    if (!anyRunning) return;
    const interval = setInterval(() => void refreshSessions(), POLL_MS);
    return () => clearInterval(interval);
  }, [anyRunning, refreshSessions]);

  return (
    <div className="panel">
      <div className="panelInner">
        {error && <div className="notice noticeError">{error}</div>}

        <h2 className="sectionTitle">Indexing</h2>
        <div className="card">
          {runs && runs.length > 0 && (
            <>
              <div className="sessionListHead">
                <span className="cardLabel">sessions; {runs.length}</span>
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

        <ReconcileRuns onChanged={onChanged} onError={setError} />
      </div>
    </div>
  );
}

function reconcileRunSummary(run: ReconcileRun): string {
  if (run.status === "running") return "reconciling…";
  const parts: string[] = [];
  if (run.retired > 0) parts.push(`${run.retired} retired`);
  if (run.folded > 0) parts.push(`${run.folded} folded`);
  if (run.questions > 0)
    parts.push(`${run.questions} ${run.questions === 1 ? "question" : "questions"}`);
  const did = parts.length > 0 ? parts.join(", ") : "nothing to do";
  const prefix =
    run.mode === "dry_run" ? "preview: " : run.trigger === "manual" ? "" : `${run.trigger}: `;
  const calls = run.llmCalls > 0 ? `; ${run.llmCalls} LLM calls` : "";
  return `${prefix}${did}${calls}`;
}

function reconcileRunLevel(run: ReconcileRun): IndexEventLevel {
  if (run.status === "error") return "error";
  if (run.status === "running") return "info";
  if (run.status === "aborted") return "warning";
  return run.revertedAt ? "warning" : "success";
}

// Reconcile runs, the same collapsible shape as an indexing session: the summary is the header,
// the findings are the body. No delete, deliberately: a reconcile run IS its undo record, so
// removing one would quietly make what it did permanent. Indexing sessions are only a log,
// which is why they can be cleared and these cannot.
function ReconcileRuns({
  onChanged,
  onError,
}: {
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [runs, setRuns] = useState<ReconcileRun[] | null>(() => cachedData<ReconcileRun[]>("reconcile-runs"));
  const [actionsByRun, setActionsByRun] = useState<Record<string, ReconcileAction[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const list = await refetch("reconcile-runs", api.reconcileRuns).catch(() => null);
    if (list) setRuns(list);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function toggle(runId: string) {
    const next = !expanded[runId];
    setExpanded((prev) => ({ ...prev, [runId]: next }));
    if (next && !actionsByRun[runId]) {
      const actions = await api.reconcileActions(runId).catch(() => null);
      if (actions) setActionsByRun((prev) => ({ ...prev, [runId]: actions }));
    }
  }

  async function undo(runId: string) {
    setBusy(runId);
    try {
      await api.revertReconcile(runId);
      setActionsByRun((prev) => ({ ...prev, [runId]: [] }));
      await refresh();
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <h2 className="sectionTitle">Reconciliation</h2>
      <div className="card">
        {runs && runs.length > 0 ? (
          <div className="sessionList">
            {runs.map((run) => {
              const level = reconcileRunLevel(run);
              const Icon = LEVEL_ICON[level];
              const Chevron = expanded[run.id] ? ChevronDown : ChevronRight;
              const undoable =
                run.mode === "apply" && !run.revertedAt && run.retired + run.folded > 0;
              return (
                <div key={run.id} className="session">
                  <div className={`sessionHeader level-${level}`}>
                    <button
                      type="button"
                      className="sessionToggle"
                      onClick={() => void toggle(run.id)}
                      aria-expanded={Boolean(expanded[run.id])}
                    >
                      <Chevron size={13} strokeWidth={1.75} className="sessionChevron" />
                      {run.status === "running" ? (
                        <Loader2 size={13} strokeWidth={1.75} className="spinIcon" />
                      ) : (
                        <Icon size={13} strokeWidth={1.75} className="levelIcon" />
                      )}
                      <span className="sessionSummary">{reconcileRunSummary(run)}</span>
                    </button>
                    <span className="sessionMeta">{run.scanned} scanned</span>
                    <span className="sessionMeta" title={new Date(run.startedAt).toLocaleString()}>
                      {relativeTime(run.startedAt)}
                    </span>
                    {run.revertedAt ? (
                      <span className="sessionMeta">undone</span>
                    ) : undoable ? (
                      <button
                        type="button"
                        className="btn btnGhost"
                        disabled={busy === run.id}
                        onClick={() => void undo(run.id)}
                      >
                        undo
                      </button>
                    ) : null}
                  </div>
                  {expanded[run.id] && (
                    <div className="sessionBody">
                      {!actionsByRun[run.id] ? (
                        <div className="sessionEmpty">loading…</div>
                      ) : actionsByRun[run.id]?.length === 0 ? (
                        <div className="sessionEmpty">nothing recorded for this run</div>
                      ) : (
                        actionsByRun[run.id]?.map((a) => (
                          <div
                            key={a.id}
                            className={`eventRow level-${a.applied ? "success" : "info"}`}
                          >
                            <span className="eventMessage">
                              {a.kind}: {a.reason}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="sessionEmpty">
            no reconcile runs yet. Start one, or turn on the passes, in Settings
          </div>
        )}
      </div>
    </>
  );
}
