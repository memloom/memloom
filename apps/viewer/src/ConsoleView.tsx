import { useEffect, useRef, useState } from "react";
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
  const [indexLog, setIndexLog] = useState<string[]>([]);
  const [rebuildArmed, setRebuildArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const indexLogRef = useRef<HTMLDivElement | null>(null);

  // Keep the newest log line in view while the run streams.
  useEffect(() => {
    const el = indexLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [indexLog]);

  async function runIndex(rebuild: boolean) {
    setIndexLog([
      rebuild ? "re-indexing from scratch (all extracted entities wiped)…" : "starting index run…",
    ]);
    const stream = rebuild ? api.reindexStream : api.indexStream;
    const result = await run(setIndexing, () =>
      stream((e) => {
        const outcome = e.skipped
          ? `(skipped: ${e.skipped})`
          : e.entities.length > 0
            ? e.entities.join(", ") +
              (e.relationships ? `  (+${e.relationships} relationships)` : "")
            : "(no entities)";
        setIndexLog((log) => [
          ...log.slice(-400),
          `[${e.index}/${e.total}] ${e.kind}  ${e.label}  →  ${outcome}`,
        ]);
      }),
    );
    if (result) {
      setIndexLog((log) => [
        ...log,
        `done — ${result.indexed} memories, ${result.chunksIndexed} chunks indexed`,
      ]);
      onChanged();
    }
  }

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
                {m.source && (
                  <>
                    {" · from "}
                    {m.source.title}
                    {m.source.headingPath ? ` › ${m.source.headingPath}` : ""}
                    {m.source.page != null ? ` (p. ${m.source.page})` : ""}
                  </>
                )}
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
          {indexLog.length > 0 && (
            <div className="indexLog" ref={indexLogRef}>
              {indexLog.map((line, i) => (
                <div
                  key={`${i}-${line.slice(0, 24)}`}
                  className={line.startsWith("done") ? "indexLogDone" : ""}
                >
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
