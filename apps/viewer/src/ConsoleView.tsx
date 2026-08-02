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
import { cachedData, prefetch, refetch } from "./prefetch";
import { toastDone, toastFailed } from "./toast";

// The run lists are cached under one key each; a run's body gets a key of its own, because
// the body is what a revisit used to re-fetch from scratch while showing "loading…". A
// finished run's events and findings never change, so they are worth keeping for the session.
export const eventsKey = (runId: string) => `index-events:${runId}`;
const reconcileActionsKey = (runId: string) => `reconcile-actions:${runId}`;

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

export function ConsoleView({
  onChanged,
  onOpenConflict,
}: {
  onChanged: () => void;
  onOpenConflict: (conflictId: string) => void;
}) {
  const [clearArmed, setClearArmed] = useState(false);

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

  // A live run's log grows, so polling has to bust its key. A finished one is immutable:
  // reuse whatever the cache holds and revalidate behind it.
  const loadEvents = useCallback(async (runId: string, live: boolean) => {
    const get = live ? refetch : prefetch;
    const events = await get(eventsKey(runId), () => api.runEvents(runId)).catch(() => null);
    if (events) setEventsByRun((prev) => ({ ...prev, [runId]: events }));
  }, []);

  // One refresh: the runs list, plus the events of every expanded session. The store is
  // the source of truth, so this is also what keeps a live run's log growing.
  const refreshSessions = useCallback(
    async (fresh: boolean) => {
      const get = fresh ? refetch : prefetch;
      const list = await get("index-runs", api.indexRuns).catch(() => null);
      if (!list) return;
      setRuns(list);
      const newest = list[0]?.id ?? null;
      await Promise.all(
        list
          .filter((run) => expandOverride[run.id] ?? run.id === newest)
          .map((run) => loadEvents(run.id, run.status === "running")),
      );
    },
    [expandOverride, loadEvents],
  );

  useEffect(() => {
    // Mount reuses the warm entry the tab hover started; the poll below is what reads live.
    void refreshSessions(false);
  }, [refreshSessions]);

  const anyRunning = runs?.some((r) => r.status === "running") ?? false;
  useEffect(() => {
    if (!anyRunning) return;
    const interval = setInterval(() => void refreshSessions(true), POLL_MS);
    return () => clearInterval(interval);
  }, [anyRunning, refreshSessions]);

  return (
    <div className="panel">
      <div className="panelInner">
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
                    await refreshSessions(true);
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
                    // The cache outlives this component, so a session opened before a tab
                    // switch comes back with its log already in it.
                    events={
                      eventsByRun[r.id] ?? cachedData<IndexRunEvent[]>(eventsKey(r.id)) ?? undefined
                    }
                    onToggle={() => {
                      const next = !isExpanded(r.id);
                      setExpandOverride((prev) => ({ ...prev, [r.id]: next }));
                      if (next) void loadEvents(r.id, r.status === "running");
                    }}
                    onDelete={async () => {
                      await api.deleteRun(r.id).catch(() => {});
                      await refreshSessions(true);
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

        <ReconcileRuns onChanged={onChanged} onError={toastFailed} onOpenConflict={onOpenConflict} />
      </div>
    </div>
  );
}

// The header has to account for everything the body will list, or a run that only raised
// conflicts reads as "nothing to do" above two questions it just asked. The counters are
// deliberately zero on a preview (nothing was done), so a preview says so instead of
// reciting zeroes as if it had found nothing.
function reconcileRunSummary(run: ReconcileRun): string {
  // A failed run has one useful thing to say and it is not the counters. Out of credit is the
  // case that matters: the sweep stopped because it could not pay, and only the message says so.
  if (run.status === "error" && run.error) return run.error;
  if (run.status === "running") {
    // A re-check sweep is minutes of model calls. The counters are written per belief, so this
    // moves; without it a long run is indistinguishable from a stuck one.
    if (run.llmCalls === 0) return "reconciling…";
    const found = run.possible > 0 ? `, ${run.possible} found` : "";
    return `reconciling… ${run.llmCalls} checked${found}`;
  }
  if (run.mode === "dry_run") return "preview, nothing applied";
  const parts: string[] = [];
  if (run.retired > 0) parts.push(`${run.retired} retired`);
  if (run.folded > 0) parts.push(`${run.folded} folded`);
  // "raised", not "to decide": a paid pass can settle a pair the free pass queued in the same
  // run, so this is how many questions the run asked, not how many are still waiting.
  if (run.conflictsRaised > 0) parts.push(`${run.conflictsRaised} raised`);
  // Not "questions": these are the integrity oddities reconciliation reports and does not fix, and
  // they are answerable nowhere, unlike the conflicts above them.
  if (run.questions > 0) parts.push(`${run.questions} flagged`);
  const did = parts.length > 0 ? parts.join(", ") : "nothing to do";
  const prefix = run.trigger === "manual" ? "" : `${run.trigger}: `;
  const calls = run.llmCalls > 0 ? `; ${run.llmCalls} LLM calls` : "";
  const cost = run.spentUsd > 0 ? `, $${run.spentUsd.toFixed(3)}` : "";
  return `${prefix}${did}${calls}${cost}`;
}

function reconcileRunLevel(run: ReconcileRun): IndexEventLevel {
  if (run.status === "error") return "error";
  if (run.status === "running") return "info";
  if (run.status === "aborted") return "warning";
  return run.revertedAt ? "warning" : "success";
}

// A run's findings load on expand, and the three states are kept apart on purpose: "no data
// yet" is not the same as "the request failed", and conflating them is how a broken fetch
// showed as a spinner that never resolved.
type ActionsState =
  | { status: "loading" }
  | { status: "ready"; actions: ReconcileAction[] }
  | { status: "error"; message: string };

function RunActions({
  state,
  onOpenConflict,
}: {
  state: ActionsState | undefined;
  onOpenConflict: (conflictId: string) => void;
}) {
  if (!state || state.status === "loading") return <div className="sessionEmpty">loading…</div>;
  if (state.status === "error") {
    return <div className="sessionEmpty sessionEmptyError">could not load: {state.message}</div>;
  }
  if (state.actions.length === 0) {
    return <div className="sessionEmpty">nothing recorded for this run</div>;
  }
  return (
    <>
      {state.actions.map((a) => {
        const level = a.applied ? "success" : "info";
        // A finding that became a conflict is answerable, so the line is the way to go answer
        // it. Everything else is a statement of what happened and stays inert.
        if (a.conflictId) {
          return (
            <button
              key={a.id}
              type="button"
              className={`eventRow eventRowLink level-${level}`}
              onClick={() => onOpenConflict(a.conflictId as string)}
              title="Open this in the conflicts tab"
            >
              <span className="eventMessage">{a.reason}</span>
            </button>
          );
        }
        return (
          <div key={a.id} className={`eventRow level-${level}`}>
            <span className="eventMessage">
              {a.kind}: {a.reason}
            </span>
          </div>
        );
      })}
    </>
  );
}

// Reconcile runs, the same collapsible shape as an indexing session: the summary is the header,
// the findings are the body. No delete, deliberately: a reconcile run IS its undo record, so
// removing one would quietly make what it did permanent. Indexing sessions are only a log,
// which is why they can be cleared and these cannot.
function ReconcileRuns({
  onChanged,
  onError,
  onOpenConflict,
}: {
  onChanged: () => void;
  onError: (message: string) => void;
  onOpenConflict: (conflictId: string) => void;
}) {
  const [runs, setRuns] = useState<ReconcileRun[] | null>(() => cachedData<ReconcileRun[]>("reconcile-runs"));
  const [actionsByRun, setActionsByRun] = useState<Record<string, ActionsState>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async (fresh: boolean) => {
    const get = fresh ? refetch : prefetch;
    const list = await get("reconcile-runs", api.reconcileRuns).catch(() => null);
    if (list) setRuns(list);
  }, []);

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  // Same treatment the indexing history gets: while anything is live, keep reading it back.
  const anyRunning = runs?.some((r) => r.status === "running") ?? false;
  useEffect(() => {
    if (!anyRunning) return;
    const interval = setInterval(() => {
      void refresh(true);
      // An expanded live run gains findings as it goes, so its body is re-read too.
      for (const run of runs ?? []) {
        if (run.status !== "running" || !expanded[run.id]) continue;
        refetch(reconcileActionsKey(run.id), () => api.reconcileActions(run.id))
          .then((actions) =>
            setActionsByRun((prev) => ({ ...prev, [run.id]: { status: "ready", actions } })),
          )
          .catch(() => {});
      }
    }, POLL_MS);
    return () => clearInterval(interval);
  }, [anyRunning, refresh, runs, expanded]);

  async function toggle(runId: string) {
    const next = !expanded[runId];
    setExpanded((prev) => ({ ...prev, [runId]: next }));
    if (!next || actionsByRun[runId]?.status === "ready") return;
    // A run opened earlier in the session is already in the cache, so show it and revalidate.
    // Otherwise mark it loading first, so a failure below can replace it: leaving the absence
    // of data to mean "loading" is what made a dead request look like a slow one.
    const cached = cachedData<ReconcileAction[]>(reconcileActionsKey(runId));
    setActionsByRun((prev) => ({
      ...prev,
      [runId]: cached ? { status: "ready", actions: cached } : { status: "loading" },
    }));
    try {
      const actions = await prefetch(reconcileActionsKey(runId), () => api.reconcileActions(runId));
      setActionsByRun((prev) => ({ ...prev, [runId]: { status: "ready", actions } }));
    } catch (err) {
      // A failed revalidation must not blank out findings that are already on screen.
      if (cached) return;
      const message = err instanceof Error ? err.message : String(err);
      setActionsByRun((prev) => ({ ...prev, [runId]: { status: "error", message } }));
    }
  }

  // Stops a live run, and is the only way to clear a row left behind by a daemon that died
  // mid-sweep. Beliefs already checked stay checked, so stopping never wastes what was paid for.
  async function stop(runId: string) {
    setBusy(runId);
    try {
      await api.stopReconcile(runId);
      await refresh(true);
      toastDone("run stopped. what it already checked stays checked");
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function undo(runId: string) {
    setBusy(runId);
    try {
      await api.revertReconcile(runId);
      // Undo changes what the run's rows say, and the cached copy is the pre-undo one. Reading
      // it back is the only way state and cache agree on what happened.
      const actions = await refetch(reconcileActionsKey(runId), () => api.reconcileActions(runId)).catch(
        () => [],
      );
      setActionsByRun((prev) => ({ ...prev, [runId]: { status: "ready", actions } }));
      await refresh(true);
      onChanged();
      toastDone("that run was undone");
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
                    {run.status === "running" ? (
                      <button
                        type="button"
                        className="btn btnGhost"
                        disabled={busy === run.id}
                        onClick={() => void stop(run.id)}
                        title="Stop this run. What it has already checked stays checked."
                      >
                        stop
                      </button>
                    ) : run.revertedAt ? (
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
                      <RunActions state={actionsByRun[run.id]} onOpenConflict={onOpenConflict} />
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
