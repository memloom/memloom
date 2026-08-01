import { useCallback, useEffect, useState } from "react";
import {
  api,
  type EntityAutoEvent,
  type EntityConflict,
  type EntityMerge,
  type SettledEntityPair,
} from "./api";
import { cachedData, prefetch, refetch } from "./prefetch";

/** What the model just said about a pair, in the words the lists below use. */
const VERDICT_LABEL: Record<EntityAutoEvent["verdict"], string> = {
  same: "folded",
  distinct: "kept apart",
  unsure: "left for you",
};

// Who decided a fold. Three answers, not two: reconciliation's LLM pass writes folds with
// decidedBy 'llm', and a fold made by a model has to say which model, or a bad one cannot be
// traced through its decisions six months later.
function foldedBy(merge: EntityMerge): string {
  if (merge.decidedBy === "auto") return "folded automatically";
  if (merge.decidedBy === "llm") return `folded by ${merge.model ?? "a model"}`;
  return "folded by you";
}

// Same three answers as a fold, for a decision that changed nothing. This is the only place a
// "these are different things" verdict can be read back from: it writes no merge row, so
// without a record it is indistinguishable from never having been asked.
function decidedByLabel(pair: SettledEntityPair): string {
  if (pair.decidedBy === "llm") return `kept apart by ${pair.model ?? "a model"}`;
  if (pair.decidedBy === "auto") return "kept apart automatically";
  return "kept apart by you";
}

// Entity resolution shares this tab on purpose: an uncertain fold is a contradiction about
// identity rather than about content, and routing it to a second queue would mean two places
// to check. It reads separately because the payload is entity-shaped, but resolve and revert
// go through the same calls, so a fold lands in the same reversible history as everything
// else the pipeline decides.
export function EntityFoldsView({ onChanged }: { onChanged: () => void }) {
  // Seeded from the prefetch cache (hover on the conflicts tab already fetched), then
  // revalidated on mount. Mutations reload through the cache-busting path below.
  const [conflicts, setConflicts] = useState<EntityConflict[]>(
    () => cachedData<EntityConflict[]>("entity-conflicts") ?? [],
  );
  const [merges, setMerges] = useState<EntityMerge[]>(
    () => cachedData<EntityMerge[]>("entity-merges") ?? [],
  );
  const [settled, setSettled] = useState<SettledEntityPair[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoProgress, setAutoProgress] = useState<EntityAutoEvent | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const fetchBoth = useCallback((fresh: boolean) => {
    const get = fresh ? refetch : prefetch;
    Promise.all([
      get("entity-conflicts", api.entityConflicts),
      get("entity-merges", api.entityMerges),
      get("entity-settled", api.settledEntityPairs),
    ])
      .then(([c, m, s]) => {
        setConflicts(c);
        setMerges(m);
        setSettled(s);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);
  const load = useCallback(() => fetchBoth(true), [fetchBoth]);

  useEffect(() => fetchBoth(false), [fetchBoth]);

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

  // The model's counterpart to "Find duplicate entities": it only ever sees pairs the rules
  // already flagged as uncertain, so the worst it can do is answer a question that was going
  // to be asked anyway. Half its value is saying "these are different", which costs nothing
  // and is recorded so the pair is never raised again.
  async function autoResolve() {
    setAutoRunning(true);
    setError(null);
    setSummary(null);
    try {
      const r = await api.autoResolveEntities(setAutoProgress);
      setSummary(
        r.calls === 0
          ? "nothing to decide"
          : `asked a model about ${r.calls} ${r.calls === 1 ? "pair" : "pairs"}: ` +
              `folded ${r.folded}, kept ${r.rejected} apart, left ${r.unsure} for you`,
      );
      load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAutoRunning(false);
      setAutoProgress(null);
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
            disabled={running || autoRunning}
            onClick={scan}
            title="Folds spellings that differ only in case or punctuation, and asks you about the rest. Every fold is reversible."
          >
            {running ? "Scanning..." : "Find duplicate entities"}
          </button>
          {conflicts.length > 0 && (
            <button
              type="button"
              className="btn"
              disabled={running || autoRunning}
              onClick={autoResolve}
              title="A model decides each pair the spelling rules could not. One call per pair. Folds it makes are reversible below, and anything it is unsure about stays here for you."
            >
              {autoRunning
                ? autoProgress
                  ? `Deciding ${autoProgress.index}/${autoProgress.total}...`
                  : "Deciding..."
                : "Resolve the obvious ones"}
            </button>
          )}
          {autoRunning && autoProgress && (
            <span style={{ color: "var(--text-faint)", alignSelf: "center" }}>
              {VERDICT_LABEL[autoProgress.verdict]}: {autoProgress.pair}
            </span>
          )}
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

        {settled.length > 0 && (
          <>
            <h2 className="sectionTitle">Kept apart; {settled.length}</h2>
            <div className="conflictList">
              {settled.map((pair) => (
                <div key={pair.id} className="card">
                  <div className="cardLabel">
                    {decidedByLabel(pair)}; {new Date(pair.resolvedAt).toLocaleString()}
                  </div>
                  <div className="statement statementExisting">
                    "{pair.incomingName}" and "{pair.candidateName}" are different things
                  </div>
                  {pair.reason && <div className="reason">{pair.reason}</div>}
                  <div className="actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={busy === pair.id}
                      onClick={() => act(pair.id, () => api.revert(pair.id))}
                    >
                      Ask me again
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {undoable.length > 0 && (
          <>
            <h2 className="sectionTitle">Folded; {undoable.length}</h2>
            <div className="conflictList">
              {undoable.map((m) => (
                <div key={m.id} className="card">
                  <div className="cardLabel">
                    {foldedBy(m)}; {new Date(m.createdAt).toLocaleString()}
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
