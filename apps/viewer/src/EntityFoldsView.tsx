import { useCallback, useEffect, useState } from "react";
import { api, type EntityConflict, type EntityMerge } from "./api";

// Entity resolution shares this tab on purpose: an uncertain fold is a contradiction about
// identity rather than about content, and routing it to a second queue would mean two places
// to check. It reads separately because the payload is entity-shaped, but resolve and revert
// go through the same calls, so a fold lands in the same reversible history as everything
// else the pipeline decides.
export function EntityFoldsView({ onChanged }: { onChanged: () => void }) {
  const [conflicts, setConflicts] = useState<EntityConflict[]>([]);
  const [merges, setMerges] = useState<EntityMerge[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([api.entityConflicts(), api.entityMerges()])
      .then(([c, m]) => {
        setConflicts(c);
        setMerges(m);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(load, [load]);

  async function scan() {
    setRunning(true);
    setError(null);
    setSummary(null);
    try {
      const r = await api.resolveEntities();
      setSummary(
        `looked at ${r.examined} entities: folded ${r.merged}, ${r.queued} to decide` +
          (r.deferred > 0 ? `, ${r.deferred} held back for a later pass` : ""),
      );
      load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  async function act(id: string, run: () => Promise<unknown>) {
    setBusy(id);
    setError(null);
    try {
      await run();
      load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const undoable = merges.filter((m) => !m.revertedAt);

  return (
    <div className="panel">
      <div className="panelInner">
        <h2 className="sectionTitle">
          Duplicate entities{conflicts.length > 0 ? `; ${conflicts.length} to decide` : ""}
        </h2>

        {error && <div className="notice noticeError">{error}</div>}

        <div className="actions" style={{ marginBottom: 12 }}>
          <button
            type="button"
            className="btn btnPrimary"
            disabled={running}
            onClick={scan}
            title="Folds spellings that differ only in case or punctuation, and asks you about the rest. Every fold is reversible."
          >
            {running ? "Scanning..." : "Find duplicate entities"}
          </button>
        </div>
        {summary && <div className="notice">{summary}</div>}

        {conflicts.length === 0 && (
          <p style={{ color: "var(--text-faint)" }}>
            Nothing to decide. When two entity names look like the same thing, the pair appears here
            so you can choose which spelling the graph keeps.
          </p>
        )}

        <div className="conflictList">
          {conflicts.map((c) => {
            const candidate = c.candidates[0];
            if (!candidate) return null;
            return (
              <div key={c.id} className="card">
                <div className="cardLabel">same thing?</div>
                <div className="statement statementNew">
                  {c.incoming.name}{" "}
                  <span style={{ color: "var(--text-faint)" }}>
                    ({c.incoming.entityType}, {c.incoming.mentions} mentions)
                  </span>
                </div>
                <div className="statement statementExisting">
                  {candidate.name}{" "}
                  <span style={{ color: "var(--text-faint)" }}>
                    ({candidate.entityType}, {candidate.mentions} mentions)
                  </span>
                </div>
                <div className="reason">{candidate.reason}</div>
                <div className="actions">
                  <button
                    type="button"
                    className="btn btnPrimary"
                    disabled={busy === c.id}
                    onClick={() =>
                      act(c.id, () =>
                        api.resolve(c.id, { action: "keep_existing", candidateId: candidate.id }),
                      )
                    }
                  >
                    Keep "{candidate.name}"
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy === c.id}
                    onClick={() => act(c.id, () => api.resolve(c.id, { action: "keep_new" }))}
                  >
                    Keep "{c.incoming.name}"
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy === c.id}
                    onClick={() => act(c.id, () => api.resolve(c.id, { action: "keep_both" }))}
                    title="Different things. They stay separate and this pair is not raised again."
                  >
                    Different things
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {undoable.length > 0 && (
          <>
            <h2 className="sectionTitle">Folded; {undoable.length}</h2>
            <div className="conflictList">
              {undoable.map((m) => (
                <div key={m.id} className="card">
                  <div className="cardLabel">
                    {m.decidedBy === "auto" ? "folded automatically" : "folded by you"};{" "}
                    {new Date(m.createdAt).toLocaleString()}
                  </div>
                  <div className="statement statementExisting">
                    "{m.sourceName}" now resolves to "{m.canonicalName}"
                  </div>
                  {m.reason && <div className="reason">{m.reason}</div>}
                  <div className="actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={busy === m.id}
                      onClick={() => act(m.id, () => api.revertEntityMerge(m.id))}
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
