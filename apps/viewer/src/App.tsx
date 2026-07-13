import { useCallback, useEffect, useState } from "react";
import { AssistantView } from "./AssistantView";
import { api, type Conflict, type Graph } from "./api";
import { ConflictsView } from "./ConflictsView";
import { ConsoleView } from "./ConsoleView";
import { DocumentsView } from "./DocumentsView";
import { GraphView } from "./GraphView";
import { MemoriesView } from "./MemoriesView";
import { SchemaView } from "./SchemaView";
import { ThemeToggle } from "./ThemeToggle";

type Tab = "graph" | "assistant" | "memories" | "documents" | "schema" | "conflicts" | "console";

export function App() {
  const [tab, setTab] = useState<Tab>("graph");
  const [graph, setGraph] = useState<Graph | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [proposalCount, setProposalCount] = useState(0);
  const [daemonDown, setDaemonDown] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [g, c, s] = await Promise.all([api.graph(), api.conflicts(), api.schema()]);
      setGraph(g);
      setConflicts(c);
      setProposalCount(s.proposals.length);
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
          {(
            [
              "graph",
              "assistant",
              "memories",
              "documents",
              "schema",
              "conflicts",
              "console",
            ] as const
          ).map((t) => (
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
              {t === "schema" && proposalCount > 0 && (
                <span className="tabBadge">{proposalCount}</span>
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
                  <b>{graph.documents.length}</b> docs
                </span>
                <span>
                  <b>{graph.edges.length}</b> edges
                </span>
              </>
            )
          )}
        </div>
        <ThemeToggle />
      </header>
      <main className="main">
        {tab === "graph" &&
          (graph ? <GraphView graph={graph} /> : <div className="emptyState">loading…</div>)}
        {tab === "assistant" && <AssistantView />}
        {tab === "memories" && <MemoriesView />}
        {tab === "documents" && <DocumentsView onChanged={refresh} />}
        {tab === "schema" && <SchemaView onChanged={refresh} />}
        {tab === "conflicts" && <ConflictsView conflicts={conflicts} onChanged={refresh} />}
        {tab === "console" && (
          <ConsoleView onChanged={refresh} goToConflicts={() => setTab("conflicts")} />
        )}
      </main>
    </div>
  );
}
