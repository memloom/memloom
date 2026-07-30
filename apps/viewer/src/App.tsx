import { useCallback, useEffect, useState } from "react";
import { AssistantView } from "./AssistantView";
import { api, type Conflict, type Graph } from "./api";
import { ConflictsView } from "./ConflictsView";
import { ConnectorsView } from "./ConnectorsView";
import { ConsoleView } from "./ConsoleView";
import { DocumentsView } from "./DocumentsView";
import { EntityFoldsView } from "./EntityFoldsView";
import { GraphView } from "./GraphView";
import { graphsEqual } from "./graphEquality";
import { MemoriesView } from "./MemoriesView";
import { SchemaView } from "./SchemaView";
import { ThemeToggle } from "./ThemeToggle";

type Tab =
  | "graph"
  | "assistant"
  | "memories"
  | "documents"
  | "schema"
  | "conflicts"
  | "connectors"
  | "console";

export function App() {
  const [tab, setTab] = useState<Tab>("graph");
  // A node the graph should select/center on next time it opens (set from an assistant source).
  const [graphFocus, setGraphFocus] = useState<string | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  // Once visited, the graph stays mounted (hidden) across tab switches so the canvas,
  // layout, zoom, and selection survive instead of rebuilding on every return.
  const [graphMounted, setGraphMounted] = useState(false);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [proposalCount, setProposalCount] = useState(0);
  const [daemonDown, setDaemonDown] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [g, c, s] = await Promise.all([api.graph(), api.conflicts(), api.schema()]);
      // Keep the previous reference when the poll brought identical data: GraphView's
      // rebuild memo and the force engine key off object identity.
      setGraph((prev) => (prev && graphsEqual(prev, g) ? prev : g));
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

  useEffect(() => {
    if (tab === "graph") setGraphMounted(true);
  }, [tab]);

  return (
    <div className="app">
      <header className="header">
        <div className="wordmark">memloom</div>
        <nav className="tabs">
          {(
            [
              "graph",
              "assistant",
              "memories",
              "documents",
              "schema",
              "conflicts",
              "connectors",
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
            <span className="offline">daemon unreachable: run `memloom serve`</span>
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
        {(graphMounted || tab === "graph") &&
          (graph ? (
            // display:contents keeps GraphView's children as direct flex items of .main
            // when visible; display:none removes them without unmounting.
            <div style={{ display: tab === "graph" ? "contents" : "none" }}>
              <GraphView
                graph={graph}
                active={tab === "graph"}
                focus={graphFocus}
                onFocusConsumed={() => setGraphFocus(null)}
                onChanged={refresh}
              />
            </div>
          ) : tab === "graph" ? (
            <div className="emptyState">loading…</div>
          ) : null)}
        {tab === "assistant" && (
          <AssistantView
            onOpenInGraph={(nodeId) => {
              setGraphFocus(nodeId);
              setTab("graph");
            }}
          />
        )}
        {tab === "memories" && <MemoriesView />}
        {tab === "documents" && <DocumentsView onChanged={refresh} />}
        {tab === "schema" && <SchemaView onChanged={refresh} />}
        {/* Entity folds sit above the memory conflicts, same tab: both are contradictions
            the pipeline flagged, one about identity and one about content. */}
        {tab === "conflicts" && (
          <>
            <EntityFoldsView onChanged={refresh} />
            <ConflictsView conflicts={conflicts} onChanged={refresh} />
          </>
        )}
        {tab === "connectors" && <ConnectorsView onChanged={refresh} />}
        {tab === "console" && <ConsoleView onChanged={refresh} />}
      </main>
    </div>
  );
}
