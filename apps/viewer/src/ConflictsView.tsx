import { useEffect, useState } from "react";
import { api, type Conflict, type ResolveDecision, type ResolvedConflict } from "./api";

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
}: {
  conflicts: Conflict[];
  onChanged: () => void;
}) {
  const [resolved, setResolved] = useState<ResolvedConflict[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mergeOpen, setMergeOpen] = useState<string | null>(null);
  const [mergeText, setMergeText] = useState("");

  // The pending list arrives via props; reloading it (onChanged) gives it a new identity,
  // so this effect also refreshes the resolved history after every resolve/revert.
  // biome-ignore lint/correctness/useExhaustiveDependencies: conflicts is the refresh signal, not an input
  useEffect(() => {
    api
      .resolvedConflicts()
      .then(setResolved)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [conflicts]);

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

        {conflicts.length === 0 && (
          <p style={{ color: "var(--text-faint)" }}>
            No conflicts to review. When a new memory contradicts an existing one, both are kept and
            the pair appears here for you to decide.
          </p>
        )}

        {conflicts.map((conflict) => {
          const single = conflict.candidates.length === 1 ? conflict.candidates[0] : undefined;
          return (
            <div key={conflict.id} className="card">
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

        {resolved && resolved.length > 0 && (
          <>
            <h2 className="sectionTitle">Resolved; {resolved.length}</h2>
            {resolved.map((r) => (
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
          </>
        )}
      </div>
    </div>
  );
}
