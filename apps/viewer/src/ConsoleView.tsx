import { useState } from "react";
import { api, type Memory, type SaveResult } from "./api";

// Console-lite: exercise the engine by hand — save, recall, index — without leaving the
// viewer. The same three calls the CLI/MCP make, so it doubles as a live API playground.

export function ConsoleView({
  onChanged,
  goToConflicts,
}: {
  onChanged: () => void;
  goToConflicts: () => void;
}) {
  const [saveText, setSaveText] = useState("");
  const [canonical, setCanonical] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<SaveResult | null>(null);

  const [query, setQuery] = useState("");
  const [recalling, setRecalling] = useState(false);
  const [results, setResults] = useState<Memory[] | null>(null);

  const [indexing, setIndexing] = useState(false);
  const [indexed, setIndexed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run<T>(setBusyState: (b: boolean) => void, fn: () => Promise<T>) {
    setBusyState(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusyState(false);
    }
  }

  return (
    <div className="panel">
      <div className="panelInner">
        {error && <div className="notice noticeError">{error}</div>}

        <h2 className="sectionTitle">Save a memory</h2>
        <div className="card">
          <textarea
            value={saveText}
            onChange={(e) => setSaveText(e.target.value)}
            placeholder="Something worth remembering…"
          />
          <div className="formRow">
            <input
              type="text"
              value={canonical}
              onChange={(e) => setCanonical(e.target.value)}
              placeholder="Canonical title (optional)"
            />
            <button
              type="button"
              className="btn btnPrimary"
              disabled={saving || saveText.trim().length === 0}
              onClick={async () => {
                const result = await run(setSaving, () =>
                  api.save({
                    content: saveText.trim(),
                    ...(canonical.trim() ? { canonical: canonical.trim() } : {}),
                  }),
                );
                if (result) {
                  setSaveResult(result);
                  setSaveText("");
                  setCanonical("");
                  onChanged();
                }
              }}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
          {saveResult && (
            <div className={`resultOutcome outcome-${saveResult.outcome}`}>
              {saveResult.outcome === "added" && `added ${saveResult.id}`}
              {saveResult.outcome === "merged" && `already known — merged into ${saveResult.id}`}
              {saveResult.outcome === "conflict" && (
                <>
                  contradiction detected — both kept.{" "}
                  <button type="button" className="btn btnGhost" onClick={goToConflicts}>
                    Review conflict →
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <h2 className="sectionTitle">Recall</h2>
        <div className="card">
          <form
            className="formRow"
            onSubmit={async (e) => {
              e.preventDefault();
              if (query.trim().length === 0) return;
              const memories = await run(setRecalling, () => api.recall(query.trim()));
              if (memories) setResults(memories);
            }}
          >
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="What do I know about…"
            />
            <button
              type="submit"
              className="btn btnPrimary"
              disabled={recalling || query.trim().length === 0}
            >
              {recalling ? "Recalling…" : "Recall"}
            </button>
          </form>
          {results?.length === 0 && <div className="spin">no memories matched</div>}
          {results?.map((m) => (
            <div key={m.id} className="recallItem">
              <div className="recallTitle">{m.canonical ?? m.content}</div>
              {m.canonical && <div className="recallContent">{m.content}</div>}
              <div className="recallMeta">
                similarity {(m.similarity ?? 0).toFixed(2)} · saved{" "}
                {new Date(m.createdAt).toLocaleString()}
              </div>
              <div className="simBar">
                <div
                  className="simBarFill"
                  style={{ width: `${Math.round((m.similarity ?? 0) * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>

        <h2 className="sectionTitle">Index</h2>
        <div className="card">
          <div className="formRow">
            <button
              type="button"
              className="btn"
              disabled={indexing}
              onClick={async () => {
                const result = await run(setIndexing, () => api.index());
                if (result) {
                  setIndexed(result.indexed);
                  onChanged();
                }
              }}
            >
              {indexing ? "Indexing…" : "Extract entities from unindexed memories"}
            </button>
            {indexed !== null && <span className="spin">indexed {indexed} memories</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
