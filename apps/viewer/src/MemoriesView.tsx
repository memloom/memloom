import { useEffect, useState } from "react";
import { api, type Memory, type MemoryType } from "./api";

// Browse every active memory, newest first — the reading counterpart to the Console's
// query-driven recall. Types carry the graph palette so a memory reads the same here as on
// the canvas (fact = memory sky; the others get their own hues).

const TYPES: MemoryType[] = ["fact", "preference", "episode", "procedure"];

const TYPE_COLOR: Record<MemoryType, string> = {
  fact: "var(--primary)",
  preference: "var(--warn)",
  episode: "var(--episode)",
  procedure: "var(--ok)",
};

export function MemoriesView() {
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<MemoryType | "all">("all");

  useEffect(() => {
    api
      .memories()
      .then(setMemories)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const counts = new Map<MemoryType, number>();
  for (const m of memories ?? []) {
    const t = m.memoryType as MemoryType;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const shown = (memories ?? []).filter((m) => filter === "all" || m.memoryType === filter);

  return (
    <div className="panel">
      <div className="panelInner">
        <h2 className="sectionTitle">Memories {memories ? `· ${memories.length} active` : ""}</h2>

        {error && <div className="notice noticeError">{error}</div>}
        {!memories && !error && <div className="spin">loading…</div>}

        {memories && memories.length === 0 && (
          <p style={{ color: "var(--text-faint)" }}>
            No memories yet. Save one from the Console tab, or ask your agent to — everything it
            remembers shows up here.
          </p>
        )}

        {memories && memories.length > 0 && (
          <div className="filterRow">
            <button
              type="button"
              className={`chip ${filter === "all" ? "chipActive" : ""}`}
              onClick={() => setFilter("all")}
            >
              all {memories.length}
            </button>
            {TYPES.map((t) => (
              <button
                key={t}
                type="button"
                className={`chip ${filter === t ? "chipActive" : ""}`}
                onClick={() => setFilter(filter === t ? "all" : t)}
              >
                {t} {counts.get(t) ?? 0}
              </button>
            ))}
          </div>
        )}

        {shown.map((m) => (
          <div key={m.id} className="recallItem">
            <div className="recallTitle">
              <span
                className="typeTag"
                style={{ color: TYPE_COLOR[m.memoryType as MemoryType] ?? "var(--text-faint)" }}
              >
                {m.memoryType}
              </span>
              {m.canonical ?? m.content}
            </div>
            {m.canonical && <div className="recallContent">{m.content}</div>}
            <div className="recallMeta">
              saved {new Date(m.createdAt).toLocaleString()} · id {m.id.slice(0, 8)}
            </div>
          </div>
        ))}

        {memories && memories.length > 0 && shown.length === 0 && (
          <p style={{ color: "var(--text-faint)" }}>No {filter} memories yet.</p>
        )}
      </div>
    </div>
  );
}
