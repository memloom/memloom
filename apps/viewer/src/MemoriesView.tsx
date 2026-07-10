import { useEffect, useState } from "react";
import { api, type Memory, type MemoryType } from "./api";

// Browse every active memory, newest first — the reading counterpart to the Console's
// query-driven recall. Each memory can be edited (a manual, human action that appends a new
// version) and its version history expanded. Types carry the graph palette so a memory reads the
// same here as on the canvas.

const TYPES: MemoryType[] = ["fact", "preference", "episode", "procedure"];

const TYPE_COLOR: Record<MemoryType, string> = {
  fact: "var(--primary)",
  preference: "var(--warn)",
  episode: "var(--episode)",
  procedure: "var(--ok)",
};

function MemoryCard({ m, onChanged }: { m: Memory; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [history, setHistory] = useState<Memory[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  async function saveEdit() {
    const next = draft.trim();
    if (!next || next === m.content) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.update(m.id, { content: next });
      setEditing(false);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleHistory() {
    if (showHistory) {
      setShowHistory(false);
      return;
    }
    setShowHistory(true);
    if (!history) {
      try {
        setHistory(await api.history(m.id));
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    }
  }

  return (
    <div className="recallItem">
      <div className="recallTitle">
        <span
          className="typeTag"
          style={{ color: TYPE_COLOR[m.memoryType as MemoryType] ?? "var(--text-faint)" }}
        >
          {m.memoryType}
        </span>
        {m.canonical ?? m.content}
        {m.version > 1 && <span className="versionTag">v{m.version}</span>}
      </div>
      {m.canonical && !editing && <div className="recallContent">{m.content}</div>}

      {editing ? (
        <div className="editBox">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            // biome-ignore lint/a11y/noAutofocus: focus the field the user just chose to edit
            autoFocus
          />
          <div className="editActions">
            <button type="button" className="btn btnPrimary" disabled={busy} onClick={saveEdit}>
              {busy ? "saving…" : "save new version"}
            </button>
            <button
              type="button"
              className="btn btnGhost"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setDraft(m.content);
              }}
            >
              cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="recallMeta">
          saved {new Date(m.createdAt).toLocaleString()} · id {m.id.slice(0, 8)}
          <button
            type="button"
            className="metaAction"
            onClick={() => {
              setDraft(m.content);
              setEditing(true);
            }}
          >
            edit
          </button>
          {m.version > 1 && (
            <button type="button" className="metaAction" onClick={toggleHistory}>
              {showHistory ? "hide history" : `history · ${m.version} versions`}
            </button>
          )}
        </div>
      )}

      {err && <div className="notice noticeError">{err}</div>}

      {showHistory && history && (
        <div className="historyList">
          {history.map((v) => (
            <div
              key={v.id}
              className={`historyRow ${v.status === "active" ? "historyRowCurrent" : ""}`}
            >
              <div className="historyMeta">
                <span className="versionTag">v{v.version}</span>
                {v.status === "active" ? "current" : "superseded"} ·{" "}
                {new Date(v.assertedAt).toLocaleString()}
              </div>
              <div className="historyContent">{v.content}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function MemoriesView() {
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<MemoryType | "all">("all");

  function load() {
    api
      .memories()
      .then(setMemories)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }
  useEffect(load, []);

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
          <MemoryCard key={m.id} m={m} onChanged={load} />
        ))}

        {memories && memories.length > 0 && shown.length === 0 && (
          <p style={{ color: "var(--text-faint)" }}>No {filter} memories yet.</p>
        )}
      </div>
    </div>
  );
}
