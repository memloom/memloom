import { useState } from "react";
import { api, type Conflict, type ResolveDecision } from "./api";

// The human-in-the-loop queue: contradictions the belief pipeline flagged. Every resolution
// is non-destructive and reversible, so each success gets an inline Undo (revert).

interface ResolvedNotice {
  conflictId: string;
  action: string;
}

export function ConflictsView({
  conflicts,
  onChanged,
}: {
  conflicts: Conflict[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notices, setNotices] = useState<ResolvedNotice[]>([]);
  const [mergeOpen, setMergeOpen] = useState<string | null>(null);
  const [mergeText, setMergeText] = useState("");

  async function resolve(conflict: Conflict, decision: ResolveDecision, label: string) {
    setBusy(conflict.id);
    setError(null);
    try {
      await api.resolve(conflict.id, decision);
      setNotices((n) => [{ conflictId: conflict.id, action: label }, ...n]);
      setMergeOpen(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function undo(conflictId: string) {
    setError(null);
    try {
      await api.revert(conflictId);
      setNotices((n) => n.filter((x) => x.conflictId !== conflictId));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="panel">
      <div className="panelInner">
        <h2 className="sectionTitle">
          Conflicts {conflicts.length > 0 ? `· ${conflicts.length} pending` : ""}
        </h2>

        {error && <div className="notice noticeError">{error}</div>}

        {notices.map((n) => (
          <div key={n.conflictId} className="notice">
            <span>
              Resolved with <b>{n.action}</b> — reversible.
            </span>
            <button type="button" className="btn btnGhost" onClick={() => undo(n.conflictId)}>
              Undo
            </button>
          </div>
        ))}

        {conflicts.length === 0 && notices.length === 0 && (
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
                  onClick={() => resolve(conflict, { action: "keep_new" }, "keep new")}
                >
                  Keep new
                </button>
                {single && (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy === conflict.id}
                    onClick={() =>
                      resolve(
                        conflict,
                        { action: "keep_existing", candidateId: single.id },
                        "keep existing",
                      )
                    }
                  >
                    Keep existing
                  </button>
                )}
                <button
                  type="button"
                  className="btn"
                  disabled={busy === conflict.id}
                  onClick={() => resolve(conflict, { action: "keep_both" }, "keep both")}
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
                        resolve(conflict, { action: "merge", content: mergeText.trim() }, "merge")
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
    </div>
  );
}
