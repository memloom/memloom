import { useCallback, useEffect, useState } from "react";
import { api, type ReconcilePass, type ReconcileReport, type ReconcileRun, type ReconcileSettings } from "./api";

// Settings. Reconciliation is the only section today, and its shape is the point: the passes are
// listed in cost order and labelled by what they cost, because two of them act on their own and
// two of them spend money. Four identical checkboxes would hide the only distinction that
// matters.

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
];

// Mirrors RECONCILE_CATCHUP_HOURS in @memloom/core. The daemon owns the decision; this is the label.
const CATCHUP_HOURS = 36;

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** What one run did, in the same order the CLI prints it. */
function runSummary(run: ReconcileRun): string {
  const parts: string[] = [];
  if (run.retired > 0) parts.push(`${run.retired} retired`);
  if (run.folded > 0) parts.push(`${run.folded} folded`);
  if (run.questions > 0) parts.push(`${run.questions} questions`);
  if (parts.length === 0) parts.push("nothing to do");
  return `${ago(run.startedAt)}, ${parts.join(", ")}`;
}

export function SettingsView({ onChanged }: { onChanged: () => void }) {
  const [settings, setSettings] = useState<ReconcileSettings | null>(null);
  const [runs, setRuns] = useState<ReconcileRun[]>([]);
  const [report, setReport] = useState<ReconcileReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([api.reconcileSettings(), api.reconcileRuns()]);
      setSettings(s);
      setRuns(r);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function toggle(patch: Partial<ReconcileSettings>) {
    if (!settings) return;
    const previous = settings;
    setSettings({ ...settings, ...patch }); // optimistic; put it back if the daemon refuses
    try {
      setSettings(await api.setReconcileSettings(patch));
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
      await refresh();
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
      await refresh();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const lastRun = runs.find((r) => r.mode === "apply" && r.status === "success") ?? null;
  const undoable = lastRun && !lastRun.revertedAt && lastRun.retired + lastRun.folded > 0;

  return (
    <div className="panel">
      <div className="panelInner">
        {error && <div className="notice noticeError">{error}</div>}

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
            {undoable && (
              <button
                type="button"
                className="btn btnGhost"
                disabled={running}
                onClick={() => void undo(lastRun.id)}
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

      {report.autoResolved && (
        <div className="reconcileGroup">
          <div className="reconcileGroupHead">contradictions</div>
          <div className="reconcileLine">
            re-judged {report.autoResolved.examined}, resolved {report.autoResolved.resolved},{" "}
            {report.autoResolved.unsure} left for you
          </div>
        </div>
      )}

      {questions.length > 0 && (
        <div className="reconcileGroup">
          <div className="reconcileGroupHead">questions</div>
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
