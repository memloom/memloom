import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type Conflict,
  type ConflictAutoEvent,
  type PossibleContradiction,
  type ResolveDecision,
  type ResolvedConflict,
} from "./api";

// The human-in-the-loop queue: contradictions the belief pipeline flagged. Every resolution
// is non-destructive and reversible, so resolved conflicts stay listed below the queue with
// a Revert that restores both memories and re-queues the pair. The history is read from the
// decision log, so resolutions made over MCP or the CLI show up here too.

const RESOLUTION_LABEL: Record<ResolvedConflict["resolution"], string> = {
  keep_new: "kept new",
  keep_existing: "kept existing",
  keep_both: "kept both",
  merge: "merged",
};

export function ConflictsView({
  conflicts,
  onChanged,
  focus,
  onFocusConsumed,
}: {
  conflicts: Conflict[];
  onChanged: () => void;
  /** A conflict to scroll to and mark, set when arriving from a reconcile run's log. */
  focus?: string | null;
  onFocusConsumed?: () => void;
}) {
  const [resolved, setResolved] = useState<ResolvedConflict[] | null>(null);
  const [possible, setPossible] = useState<PossibleContradiction[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mergeOpen, setMergeOpen] = useState<string | null>(null);
  const [mergeText, setMergeText] = useState("");
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoProgress, setAutoProgress] = useState<ConflictAutoEvent | null>(null);
  const [autoSummary, setAutoSummary] = useState<string | null>(null);
  const [pendingFilter, setPendingFilter] = useState("");
  const [resolvedFilter, setResolvedFilter] = useState("");
  // Arriving from a reconcile run's log: scroll the named conflict into view, then let the mark
  // go so it does not stay highlighted for the rest of the session.
  const focusRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!focus || !focusRef.current) return;
    focusRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    const timer = setTimeout(() => onFocusConsumed?.(), 2000);
    return () => clearTimeout(timer);
  }, [focus, onFocusConsumed]);

  const matches = (filter: string) => {
    const needle = filter.trim().toLowerCase();
    return (c: Conflict) =>
      !needle ||
      c.incoming.content.toLowerCase().includes(needle) ||
      c.candidates.some((cand) => cand.content.toLowerCase().includes(needle));
  };
  const visibleConflicts = conflicts.filter(matches(pendingFilter));
  const visibleResolved = (resolved ?? []).filter(matches(resolvedFilter));

  // The pending list arrives via props; reloading it (onChanged) gives it a new identity,
  // so this effect also refreshes the resolved history after every resolve/revert.
  // biome-ignore lint/correctness/useExhaustiveDependencies: conflicts is the refresh signal, not an input
  useEffect(() => {
    api
      .resolvedConflicts()
      .then(setResolved)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [conflicts]);

  const loadPossible = useCallback(() => {
    api
      .possibleContradictions()
      .then(setPossible)
      // An older daemon has no such route, and an empty list is the right answer then.
      .catch(() => setPossible([]));
  }, []);
  useEffect(loadPossible, [loadPossible]);

  async function resolve(conflict: Conflict, decision: ResolveDecision) {
    setBusy(conflict.id);
    setError(null);
    try {
      await api.resolve(conflict.id, decision);
      setMergeOpen(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function autoResolve() {
    setAutoRunning(true);
    setAutoSummary(null);
    setError(null);
    try {
      const result = await api.autoResolveConflicts(setAutoProgress);
      setAutoSummary(
        `resolved ${result.resolved} of ${result.examined} ` +
          `(${result.keepNew} kept new, ${result.keepExisting} kept existing, ` +
          `${result.keepBoth} kept both); ${result.unsure} left for you`,
      );
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAutoRunning(false);
      setAutoProgress(null);
    }
  }

  // Approving promotes the finding into a real conflict, which lands in the pending list above;
  // rejecting records the pair so no later run asks about it again. Both are one click, which is
  // the point: this pass is right about 4 findings in 10, so dismissing has to be cheap.
  async function answer(id: string, decision: "approved" | "rejected") {
    setBusy(id);
    setError(null);
    try {
      await api.answerPossible(id, decision);
      loadPossible();
      if (decision === "approved") onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function revert(conflictId: string) {
    setBusy(conflictId);
    setError(null);
    try {
      await api.revert(conflictId);
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
        <h2 className="sectionTitle">
          Conflicts{conflicts.length > 0 ? `; ${conflicts.length} pending` : ""}
        </h2>

        {error && <div className="notice noticeError">{error}</div>}

        {conflicts.length > 0 && (
          <div className="actions" style={{ marginBottom: 12 }}>
            <button
              type="button"
              className="btn btnPrimary"
              disabled={autoRunning}
              onClick={autoResolve}
              title="An LLM re-judges each conflict with its provenance context. Decisive verdicts are applied (revertable below); unclear ones stay here for you."
            >
              {autoRunning
                ? autoProgress
                  ? `Resolving ${autoProgress.index}/${autoProgress.total}...`
                  : "Resolving..."
                : "Resolve the obvious ones"}
            </button>
            {autoRunning && autoProgress && (
              <span style={{ color: "var(--text-faint)", alignSelf: "center" }}>
                {autoProgress.verdict === "unsure"
                  ? "left for you"
                  : autoProgress.verdict.replace("_", " ")}
                : {autoProgress.content}
              </span>
            )}
          </div>
        )}
        {autoSummary && <div className="notice">{autoSummary}</div>}

        {conflicts.length === 0 && (
          <p style={{ color: "var(--text-faint)" }}>
            No conflicts to review. When a new memory contradicts an existing one, both are kept and
            the pair appears here for you to decide.
          </p>
        )}

        {conflicts.length > 3 && (
          <input
            type="text"
            className="entityFilter"
            placeholder="Filter pending conflicts..."
            value={pendingFilter}
            onChange={(e) => setPendingFilter(e.target.value)}
          />
        )}
        <div className="conflictList">
          {visibleConflicts.map((conflict) => {
            const single = conflict.candidates.length === 1 ? conflict.candidates[0] : undefined;
            return (
              <div
                key={conflict.id}
                ref={conflict.id === focus ? focusRef : undefined}
                className={`card ${conflict.id === focus ? "cardFocused" : ""}`}
              >
                <div className="cardLabel">new</div>
                <div className="statement statementNew">{conflict.incoming.content}</div>
                {conflict.candidates.map((candidate) => (
                  <div key={candidate.id}>
                    <div className="cardLabel">existing</div>
                    <div className="statement statementExisting">{candidate.content}</div>
                    {candidate.reason && <div className="reason">{candidate.reason}</div>}
                  </div>
                ))}
                <div className="actions">
                  <button
                    type="button"
                    className="btn btnPrimary"
                    disabled={busy === conflict.id}
                    onClick={() => resolve(conflict, { action: "keep_new" })}
                  >
                    Keep new
                  </button>
                  {single && (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy === conflict.id}
                      onClick={() =>
                        resolve(conflict, { action: "keep_existing", candidateId: single.id })
                      }
                    >
                      Keep existing
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn"
                    disabled={busy === conflict.id}
                    onClick={() => resolve(conflict, { action: "keep_both" })}
                  >
                    Keep both
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy === conflict.id}
                    onClick={() => {
                      setMergeOpen(mergeOpen === conflict.id ? null : conflict.id);
                      setMergeText(conflict.incoming.content);
                    }}
                  >
                    Merge…
                  </button>
                </div>
                {mergeOpen === conflict.id && (
                  <>
                    <textarea
                      value={mergeText}
                      onChange={(e) => setMergeText(e.target.value)}
                      placeholder="The reconciled statement that replaces both"
                    />
                    <div className="actions">
                      <button
                        type="button"
                        className="btn btnPrimary"
                        disabled={busy === conflict.id || mergeText.trim().length === 0}
                        onClick={() =>
                          resolve(conflict, { action: "merge", content: mergeText.trim() })
                        }
                      >
                        Save merged memory
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>

        {/* Reconciliation's re-check finds beliefs that did not contradict anything when either was
            saved. It is right about roughly 4 in 10, so these are not conflicts and never touch
            the tab badge: they sit here as two quoted lines until you say otherwise. */}
        {possible.length > 0 && (
          <>
            <h2 className="sectionTitle">Possible contradictions; {possible.length}</h2>
            <p className="cardNote">
              Found by reconciliation, not confirmed. Each one quotes the two claims that clash, so it
              reads in a few seconds. Confirming makes it a conflict above; dismissing means this
              pair is never raised again.
            </p>
            <div className="conflictList">
              {possible.map((p) => (
                <div key={p.id} className="card cardPossible">
                  <div className="cardLabel">
                    {p.model ? `${p.model} says` : "says"}: {p.reason}
                  </div>
                  <div className="statement statementNew">
                    <span className="quoteSpan">{p.newQuote}</span>
                  </div>
                  <div className="statement statementExisting">
                    <span className="quoteSpan">{p.oldQuote}</span>
                  </div>
                  <details className="possibleFull">
                    <summary>the two memories in full</summary>
                    <div className="reason">{p.newMemory.content}</div>
                    <div className="reason">{p.oldMemory.content}</div>
                  </details>
                  <div className="actions">
                    <button
                      type="button"
                      className="btn btnPrimary"
                      disabled={busy === p.id}
                      onClick={() => answer(p.id, "approved")}
                      title="Make this a real conflict, with the four resolution choices."
                    >
                      These conflict
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy === p.id}
                      onClick={() => answer(p.id, "rejected")}
                      title="Not a contradiction. This pair is never raised again."
                    >
                      No
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {resolved && resolved.length > 0 && (
          <>
            <h2 className="sectionTitle">Resolved; {resolved.length}</h2>
            {resolved.length > 3 && (
              <input
                type="text"
                className="entityFilter"
                placeholder="Filter resolved conflicts..."
                value={resolvedFilter}
                onChange={(e) => setResolvedFilter(e.target.value)}
              />
            )}
            <div className="conflictList">
              {visibleResolved.map((r) => (
                <div key={r.id} className="card">
                  <div className="cardLabel">
                    {RESOLUTION_LABEL[r.resolution]}; {new Date(r.resolvedAt).toLocaleString()}
                  </div>
                  <div className="statement statementNew">{r.incoming.content}</div>
                  {r.candidates.map((candidate) => (
                    <div key={candidate.id} className="statement statementExisting">
                      {candidate.content}
                    </div>
                  ))}
                  <div className="actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={busy === r.id}
                      onClick={() => revert(r.id)}
                    >
                      Revert
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
