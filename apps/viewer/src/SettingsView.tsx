import { useCallback, useEffect, useState } from "react";
import { api, type ReconcilePass, type ReconcileReport, type ReconcileRun, type ReconcileSettings } from "./api";
import { cachedData, prefetch, refetch, seed } from "./prefetch";

// Settings: everything that decides what the engine does to itself on its own, and the buttons
// that start it doing so. The Console is the other half, and it is read-only apart from undo:
// this tab answers "what should happen", that one answers "what happened".
//
// Reconciliation's shape is the point: the passes are listed in cost order and labelled by what they
// cost, because two of them act on their own and two of them spend money. Four identical
// checkboxes would hide the only distinction that matters.

const PASSES: Array<{ pass: ReconcilePass; label: string; cost: string; free: boolean }> = [
  {
    pass: "invariants",
    label: "Fix memory principle violations",
    cost: "free, acts on its own",
    free: true,
  },
  {
    pass: "entities",
    label: "Resolve duplicate entities",
    cost: "free, acts on its own",
    free: true,
  },
  {
    pass: "llm_entities",
    label: "Let a model resolve uncertain entity pairs",
    cost: "costs money, one call per pair",
    free: false,
  },
  {
    pass: "llm_conflicts",
    label: "Let a model resolve memory conflicts",
    cost: "costs money, one call per conflict",
    free: false,
  },
  // The only pass that sweeps rather than draining a queue, so it is the only one whose cost grows
  // with how long since the last run. Measured on a real store: about a third of a cent per belief,
  // capped at 200 beliefs a run, so roughly 55 cents in the worst case.
  {
    pass: "llm_recheck",
    label: "Look for contradictions the save path could not see",
    cost: "costs money, up to 200 calls per run",
    free: false,
  },
];

// Mirrors RECONCILE_CATCHUP_HOURS in @memloom/core. The daemon owns the decision; this is the label.
const CATCHUP_HOURS = 36;

type AutoIndexState = { enabled: boolean; available: boolean };

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** What one run did, in the same order the CLI prints it. Applied runs only. */
function runSummary(run: ReconcileRun): string {
  const parts: string[] = [];
  if (run.retired > 0) parts.push(`${run.retired} retired`);
  if (run.folded > 0) parts.push(`${run.folded} folded`);
  if (run.conflictsRaised > 0) parts.push(`${run.conflictsRaised} raised`);
  if (run.questions > 0) parts.push(`${run.questions} flagged`);
  if (parts.length === 0) parts.push("nothing to do");
  return `${ago(run.startedAt)}, ${parts.join(", ")}`;
}

/**
 * Indexing. Entity extraction is the other thing memloom does to its own store without being
 * asked each time, so its switch and its two manual triggers belong next to reconciliation's rather
 * than in the Console. The history stays in the Console with the reconcile runs.
 */
function IndexingSection({
  onChanged,
  onError,
}: {
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  // Seeded from the cache the header's hover already warmed, then revalidated. The toggle is
  // hidden until this lands, so without a seed a revisit renders the section a row short.
  const [autoIdx, setAutoIdx] = useState<AutoIndexState | null>(() =>
    cachedData<AutoIndexState>("auto-index"),
  );
  const [indexing, setIndexing] = useState(false);
  const [rebuildArmed, setRebuildArmed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    prefetch("auto-index", api.autoIndex)
      .then(setAutoIdx)
      .catch(() => setAutoIdx(null));
  }, []);

  async function toggleAutoIndex() {
    if (!autoIdx?.available) return;
    const next = { ...autoIdx, enabled: !autoIdx.enabled };
    setAutoIdx(next); // optimistic; put it back on failure
    try {
      await api.setAutoIndex(next.enabled);
      seed("auto-index", next);
    } catch (err) {
      setAutoIdx({ ...autoIdx });
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function runIndex(rebuild: boolean) {
    setIndexing(true);
    setNotice(null);
    try {
      const result = rebuild ? await api.reindex() : await api.index();
      if (result.indexed === 0 && result.chunksIndexed === 0) {
        setNotice("everything is already indexed");
      }
      // The run this just wrote is the Console's history, and the Console now seeds from the
      // cache. Without this, walking straight over there shows the list from before the run.
      void refetch("index-runs", api.indexRuns).catch(() => {});
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setIndexing(false);
    }
  }

  return (
    <>
      <h2 className="sectionTitle">Indexing</h2>
      <div className="card">
        <p className="cardNote">
          Extracting entities and relationships from memories and documents. The run log is in the
          Console.
        </p>

        {autoIdx && (
          <div className="passList">
            <button
              type="button"
              className={`passRow ${autoIdx.enabled ? "passRowOn" : ""}`}
              disabled={!autoIdx.available}
              onClick={() => void toggleAutoIndex()}
            >
              <span className="autoIndexTrack">
                <span className="autoIndexKnob" />
              </span>
              <span className="passLabel">Index new memories and files automatically</span>
              <span className="passCost">
                {autoIdx.available ? "a few seconds after they land" : "needs OPENROUTER_API_KEY"}
              </span>
            </button>
          </div>
        )}

        <div className="formRow">
          <button
            type="button"
            className="btn"
            disabled={indexing}
            onClick={() => {
              setRebuildArmed(false);
              void runIndex(false);
            }}
          >
            {indexing ? "Indexing…" : "Extract entities from unindexed memories & context"}
          </button>
          <button
            type="button"
            className={`btn ${rebuildArmed ? "btnDangerArmed" : ""}`}
            disabled={indexing}
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
        </div>
        {notice && <div className="sessionEmpty">{notice}</div>}
      </div>
    </>
  );
}

export function SettingsView({ onChanged }: { onChanged: () => void }) {
  // Both seed from the cache the tab hover warmed, so a revisit paints the toggles and the
  // last-run line straight away and revalidates behind them.
  const [settings, setSettings] = useState<ReconcileSettings | null>(() =>
    cachedData<ReconcileSettings>("reconcile-settings"),
  );
  const [runs, setRuns] = useState<ReconcileRun[]>(() => cachedData<ReconcileRun[]>("reconcile-runs") ?? []);
  const [report, setReport] = useState<ReconcileReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // fresh: after a run, where the cached copy is the pre-run one by definition. On mount the
  // warm entry is reused instead, so hover-then-click costs one request between them.
  const load = useCallback(async (fresh: boolean) => {
    const get = fresh ? refetch : prefetch;
    try {
      const [s, r] = await Promise.all([
        get("reconcile-settings", api.reconcileSettings),
        get("reconcile-runs", api.reconcileRuns),
      ]);
      setSettings(s);
      setRuns(r);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  async function toggle(patch: Partial<ReconcileSettings>) {
    if (!settings) return;
    const previous = settings;
    setSettings({ ...settings, ...patch }); // optimistic; put it back if the daemon refuses
    try {
      // The response is the saved settings, so the cache can be told rather than asked.
      const saved = await api.setReconcileSettings(patch);
      setSettings(saved);
      seed("reconcile-settings", saved);
    } catch (err) {
      setSettings(previous);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function run(mode: "dry_run" | "apply") {
    setRunning(true);
    setError(null);
    try {
      setReport(await api.reconcile(mode));
      await load(true);
      // A run that folded or retired something changed the graph the other tabs are showing.
      if (mode === "apply") onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  async function undo(runId: string) {
    setError(null);
    try {
      await api.revertReconcile(runId);
      setReport(null);
      await load(true);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const lastRun = runs.find((r) => r.mode === "apply" && r.status === "success") ?? null;
  // Undo for the run you just started, where you are already looking. Undo for any older run
  // lives in the Console next to the rest of the history.
  const justRan = report?.run.mode === "apply" && report.run.retired + report.run.folded > 0;

  return (
    <div className="panel">
      <div className="panelInner">
        {error && <div className="notice noticeError">{error}</div>}

        <IndexingSection onChanged={onChanged} onError={setError} />

        <h2 className="sectionTitle">Reconciliation</h2>
        <div className="card">
          <p className="cardNote">
            memloom goes over its own store, repairs what it can prove is wrong, and asks about what
            it cannot decide alone. Everything a run does is undoable, one run at a time.
          </p>

          {settings && (
            <div className="passList">
              {PASSES.map(({ pass, label, cost, free }) => (
                <button
                  key={pass}
                  type="button"
                  className={`passRow ${settings[pass] ? "passRowOn" : ""}`}
                  onClick={() => void toggle({ [pass]: !settings[pass] } as Partial<ReconcileSettings>)}
                >
                  <span className="autoIndexTrack">
                    <span className="autoIndexKnob" />
                  </span>
                  <span className="passLabel">{label}</span>
                  <span className={`passCost ${free ? "" : "passCostPaid"}`}>{cost}</span>
                </button>
              ))}

              <button
                type="button"
                className={`passRow ${settings.startupCatchUp ? "passRowOn" : ""}`}
                onClick={() => void toggle({ startupCatchUp: !settings.startupCatchUp })}
              >
                <span className="autoIndexTrack">
                  <span className="autoIndexKnob" />
                </span>
                <span className="passLabel">
                  On startup, catch up if there was no run in the past {CATCHUP_HOURS} hours
                </span>
                <span className="passCost">free passes only</span>
              </button>
            </div>
          )}

          <div className="formRow">
            <button
              type="button"
              className="btn"
              disabled={running}
              onClick={() => void run("apply")}
            >
              {running ? "Reconciling…" : "Reconcile now"}
            </button>
            <button
              type="button"
              className="btn btnGhost"
              disabled={running}
              onClick={() => void run("dry_run")}
            >
              Preview only
            </button>
            {lastRun && <span className="cardLabel">last run: {runSummary(lastRun)}</span>}
            {justRan && report && (
              <button
                type="button"
                className="btn btnGhost"
                disabled={running}
                onClick={() => void undo(report.run.id)}
              >
                undo that run
              </button>
            )}
          </div>

          {report && <ReconcileReportCard report={report} />}
        </div>
      </div>
    </div>
  );
}

/** The run's own words. Repairs, folds, then the questions, then what a paid pass would cost. */
function ReconcileReportCard({ report }: { report: ReconcileReport }) {
  const dry = report.run.mode === "dry_run";
  const retire = report.actions.filter((a) => a.kind === "retire" && a.surfaced);
  const folds = report.actions.filter((a) => a.kind === "fold");
  const questions = report.actions.filter((a) => a.kind === "question" && a.surfaced);
  // Pairs the model settled are already named under arbitration, so leave them out here and
  // this group is the questions the run put to the user.
  const arbitrated = new Set((report.arbitration?.settled ?? []).map((s) => s.conflictId));
  const raised = report.actions.filter(
    (a) => a.kind === "conflict" && !arbitrated.has(a.conflictId ?? ""),
  );
  const { estimate } = report;

  return (
    <div className="reconcileReport">
      <div className="cardLabel">
        {dry ? "preview" : "run"}; scanned {report.run.scanned} memories
      </div>

      {retire.length > 0 && (
        <div className="reconcileGroup">
          <div className="reconcileGroupHead">{dry ? "would retire" : "retired"}</div>
          {retire.map((a) => (
            <div key={a.id} className="reconcileLine">
              {a.reason}
            </div>
          ))}
        </div>
      )}

      {report.entities && (
        <div className="reconcileGroup">
          <div className="reconcileGroupHead">entities</div>
          {report.entities.merged === 0 && report.entities.queued === 0 && (
            <div className="reconcileLine">no duplicate names found</div>
          )}
          {dry && report.entities.merged > 0 && (
            <div className="reconcileLine">would fold {report.entities.merged} name variants</div>
          )}
          {folds.map((a) => (
            <div key={a.id} className="reconcileLine">
              {a.reason}
            </div>
          ))}
          {report.entities.queued > 0 && (
            <div className="reconcileLine">
              {report.entities.queued} uncertain pairs {dry ? "would go" : "went"} to the conflicts
              tab
            </div>
          )}
        </div>
      )}

      {report.arbitration && (
        <div className="reconcileGroup">
          <div className="reconcileGroupHead">
            a model settled {report.arbitration.folded + report.arbitration.rejected} pairs in{" "}
            {report.arbitration.calls} calls
          </div>
          {report.arbitration.settled.map((s) => (
            <div key={s.conflictId} className="reconcileLine">
              {s.reason}
            </div>
          ))}
          {report.arbitration.unsure > 0 && (
            <div className="reconcileLine reconcileLineMuted">
              {report.arbitration.unsure} left for you: the model would not commit
            </div>
          )}
        </div>
      )}

      {report.recheck && (
        <div className="reconcileGroup">
          <div className="reconcileGroupHead">contradiction re-check</div>
          <div className="reconcileLine">
            swept {report.recheck.calls} beliefs against their 20 nearest, kept{" "}
            {report.recheck.verified} of {report.recheck.claimed} the model claimed
          </div>
          {report.recheck.claimed > report.recheck.verified && (
            <div className="reconcileLine reconcileLineMuted">
              {report.recheck.claimed - report.recheck.verified} dropped: the model could not quote
              the clashing claim from both memories
            </div>
          )}
          {report.recheck.remaining > 0 && (
            <div className="reconcileLine reconcileLineMuted">
              {report.recheck.remaining} beliefs left for the next run, so one run cannot run up a
              bill
            </div>
          )}
          {report.recheck.verified > 0 && (
            <div className="reconcileLine">waiting for you in the conflicts tab</div>
          )}
        </div>
      )}

      {report.autoResolved && (
        <div className="reconcileGroup">
          <div className="reconcileGroupHead">contradictions</div>
          <div className="reconcileLine">
            re-judged {report.autoResolved.examined}, resolved {report.autoResolved.resolved},{" "}
            {report.autoResolved.unsure} left for you
          </div>
        </div>
      )}

      {raised.length > 0 && (
        <div className="reconcileGroup">
          <div className="reconcileGroupHead">asked in the conflicts tab</div>
          {raised.map((a) => (
            <div key={a.id} className="reconcileLine">
              {a.reason}
            </div>
          ))}
          {report.heldBack.conflict > 0 && (
            <div className="reconcileLine reconcileLineMuted">
              and {report.heldBack.conflict} more, left for a later run
            </div>
          )}
        </div>
      )}

      {questions.length > 0 && (
        <div className="reconcileGroup">
          <div className="reconcileGroupHead">noticed, not fixed</div>
          {questions.map((a) => (
            <div key={a.id} className="reconcileLine">
              {a.reason}
            </div>
          ))}
          {report.heldBack.question > 0 && (
            <div className="reconcileLine reconcileLineMuted">
              and {report.heldBack.question} more, held back so this stays readable
            </div>
          )}
        </div>
      )}

      {estimate.window > 0 && (
        <div className="reconcileGroup">
          <div className="reconcileGroupHead">contradiction re-check</div>
          <div className="reconcileLine reconcileLineMuted">
            {estimate.window} memories in the window; a real run would make {estimate.llmCalls}{" "}
            calls with {estimate.model}
            {estimate.usd !== null && `, about $${estimate.usd.toFixed(2)}`}
          </div>
          <div className="reconcileLine reconcileLineMuted">
            the contradiction pass is not built yet: this is the estimate, not a result
          </div>
        </div>
      )}
    </div>
  );
}
