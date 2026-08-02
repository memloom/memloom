import { useCallback, useEffect, useState } from "react";
import { AssistantView } from "./AssistantView";
import { api, type Conflict, type Graph } from "./api";
import { ConflictsView } from "./ConflictsView";
import { ConnectorsView } from "./ConnectorsView";
import { ConsoleView, eventsKey } from "./ConsoleView";
import { DocumentsView } from "./DocumentsView";
import { GraphView } from "./GraphView";
import { graphsEqual } from "./graphEquality";
import { MemoriesView } from "./MemoriesView";
import { prefetch } from "./prefetch";
import { SchemaView } from "./SchemaView";
import { SettingsView } from "./SettingsView";
import { ThemeToggle } from "./ThemeToggle";

type Tab =
  | "graph"
  | "assistant"
  | "memories"
  | "documents"
  | "schema"
  | "conflicts"
  | "connectors"
  | "console"
  | "settings";

// Hovering a tab starts its data fetches before the click lands, and the same keys seed
// each view's first render (see prefetch.ts), so a switch shows data rather than
// "loading". Keys must match what the views prefetch on mount, or the two would race as
// separate requests instead of sharing one.
const TAB_PREFETCH: Partial<Record<Tab, () => void>> = {
  memories: () => void prefetch("memories", api.memories).catch(() => {}),
  documents: () => {
    void prefetch("documents", api.documents).catch(() => {});
    void prefetch("queue", api.queue).catch(() => {});
  },
  schema: () => {
    void prefetch("schema", api.schema).catch(() => {});
    void prefetch("entities", api.entities).catch(() => {});
  },
  conflicts: () => {
    // The memory conflicts themselves live in App's poll already; the folds do not.
    void prefetch("entity-conflicts", api.entityConflicts).catch(() => {});
    void prefetch("entity-merges", api.entityMerges).catch(() => {});
  },
  // The Console holds both histories now, so it warms both. The newest indexing session is
  // expanded on arrival, so its log is warmed too: without that one chained fetch the Console
  // still opens on a "loading…" body, which is the whole thing this is here to avoid.
  console: () => {
    void prefetch("index-runs", api.indexRuns)
      .then((runs) => {
        const newest = runs[0];
        if (!newest) return;
        void prefetch(eventsKey(newest.id), () => api.runEvents(newest.id)).catch(() => {});
      })
      .catch(() => {});
    void prefetch("reconcile-runs", api.reconcileRuns).catch(() => {});
  },
  settings: () => {
    void prefetch("reconcile-settings", api.reconcileSettings).catch(() => {});
    void prefetch("reconcile-runs", api.reconcileRuns).catch(() => {});
    void prefetch("auto-index", api.autoIndex).catch(() => {});
  },
};

export function App() {
  const [tab, setTab] = useState<Tab>("graph");
  // A node the graph should select/center on next time it opens (set from an assistant source).
  const [graphFocus, setGraphFocus] = useState<string | null>(null);
  // Same idea for the conflicts tab, set when a reconcile run's log line is clicked.
  const [conflictFocus, setConflictFocus] = useState<string | null>(null);
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

  // Warm every tab's cache once, shortly after first paint: hover-prefetch covers a mouse,
  // but the first keyboard or touch visit to a tab deserves data too. A handful of small
  // GETs against a localhost daemon, delayed so they never compete with the initial graph.
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const warm of Object.values(TAB_PREFETCH)) warm();
    }, 500);
    return () => clearTimeout(timer);
  }, []);

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
              "settings",
            ] as const
          ).map((t) => (
            <button
              key={t}
              type="button"
              className={`tab ${tab === t ? "tabActive" : ""}`}
              onMouseEnter={TAB_PREFETCH[t]}
              onFocus={TAB_PREFETCH[t]}
              onClick={() => {
                TAB_PREFETCH[t]?.();
                setTab(t);
              }}
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
        {/* One inbox for every kind of "you decide": entity folds, memory conflicts, and the
            unconfirmed pairs reconciliation found. They share a rail so none of them is below the fold. */}
        {tab === "conflicts" && (
          <ConflictsView
            conflicts={conflicts}
            onChanged={refresh}
            focus={conflictFocus}
            onFocusConsumed={() => setConflictFocus(null)}
          />
        )}
        {tab === "connectors" && <ConnectorsView onChanged={refresh} />}
        {tab === "console" && (
          <ConsoleView
            onChanged={refresh}
            onOpenConflict={(conflictId) => {
              setConflictFocus(conflictId);
              setTab("conflicts");
            }}
          />
        )}
        {tab === "settings" && <SettingsView onChanged={refresh} />}
      </main>
    </div>
  );
}
