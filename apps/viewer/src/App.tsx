import { useCallback, useEffect, useState } from "react";
import { api, type Conflict, type Graph } from "./api";
import { ConflictsView } from "./ConflictsView";
import { ConsoleView } from "./ConsoleView";
import { GraphView } from "./GraphView";

type Tab = "graph" | "conflicts" | "console";

export function App() {
  const [tab, setTab] = useState<Tab>("graph");
  const [graph, setGraph] = useState<Graph | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [daemonDown, setDaemonDown] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [g, c] = await Promise.all([api.graph(), api.conflicts()]);
      setGraph(g);
      setConflicts(c);
      setDaemonDown(false);
    } catch {
      setDaemonDown(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <div className="app">
      <header className="header">
        <div className="wordmark">
          mem<span>loom</span>
        </div>
        <nav className="tabs">
          {(["graph", "conflicts", "console"] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`tab ${tab === t ? "tabActive" : ""}`}
              onClick={() => setTab(t)}
            >
              {t}
              {t === "conflicts" && conflicts.length > 0 && (
                <span className="tabBadge">{conflicts.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="headerStats">
          {daemonDown ? (
            <span className="offline">daemon unreachable — run `memloom serve`</span>
          ) : (
            graph && (
              <>
                <span>
                  <b>{graph.memories.length}</b> memories
                </span>
                <span>
                  <b>{graph.entities.length}</b> entities
                </span>
                <span>
                  <b>{graph.edges.length}</b> edges
                </span>
              </>
            )
          )}
        </div>
      </header>
      <main className="main">
        {tab === "graph" &&
          (graph ? <GraphView graph={graph} /> : <div className="emptyState">loading…</div>)}
        {tab === "conflicts" && <ConflictsView conflicts={conflicts} onChanged={refresh} />}
        {tab === "console" && (
          <ConsoleView onChanged={refresh} goToConflicts={() => setTab("conflicts")} />
        )}
      </main>
    </div>
  );
}
