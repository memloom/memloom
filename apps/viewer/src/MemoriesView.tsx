import { useCallback, useEffect, useState } from "react";
import { api, type Memory, type MemoryType } from "./api";
import { RecallCard, SaveMemoryCard } from "./cards";
import { cachedData, prefetch, refetch } from "./prefetch";
import { flattenScopes, ScopePicker, type ScopeSelection, ScopeTree, useScopes } from "./ScopeTree";
import { toastDone } from "./toast";

// Browse every active memory, newest first. The reading counterpart to the Console's
// query-driven recall. Each memory can be edited (a manual, human action that appends a new
// version), its version history expanded, or removed outright (two-step confirm; deletes
// the whole version chain). The folder sidebar narrows the list to one subtree, and
// multi-select feeds the bulk "move to folder" action.

const TYPES: MemoryType[] = ["fact", "preference", "episode", "procedure"];

function MemoryCard({
  m,
  onChanged,
  checked,
  onToggle,
  onTag,
}: {
  m: Memory;
  onChanged: () => void;
  checked: boolean;
  onToggle: () => void;
  /** Clicking a tag chip filters the list by that tag. */
  onTag: (tag: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [history, setHistory] = useState<Memory[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [arming, setArming] = useState(false);

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

  async function remove() {
    if (!arming) {
      setArming(true);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.deleteMemory(m.id);
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
        <input
          type="checkbox"
          className="cardCheck"
          checked={checked}
          onChange={onToggle}
          aria-label="Select this memory"
        />
        <span className="typeTag">{m.memoryType}</span>
        {m.canonical ?? m.content}
        {m.version > 1 && <span className="versionTag">v{m.version}</span>}
      </div>
      {m.canonical && !editing && <div className="recallContent">{m.content}</div>}

      <div className="chipLine">
        <span className="scopeTag">{m.scopePath ?? "uncategorized"}</span>
        {(m.tags ?? []).map((t) => (
          <button key={t} type="button" className="tagChip" onClick={() => onTag(t)}>
            {t}
          </button>
        ))}
      </div>

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
          saved {new Date(m.createdAt).toLocaleString()}; id {m.id.slice(0, 8)}
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
              {showHistory ? "hide history" : `history; ${m.version} versions`}
            </button>
          )}
          <button
            type="button"
            className="metaAction metaActionDanger"
            disabled={busy}
            onClick={remove}
            onBlur={() => setArming(false)}
          >
            {arming ? "confirm remove" : "remove"}
          </button>
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
                {v.status === "active" ? "current" : "superseded"};{" "}
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
  const [scopeSel, setScopeSel] = useState<ScopeSelection | null>(null);
  // The tree refreshes after list mutations here (a move changes the counts), and the
  // pickers refresh after tree mutations there (a new folder must appear as a target).
  const [treeVersion, setTreeVersion] = useState(0);
  const [scopesVersion, setScopesVersion] = useState(0);
  const { scopes } = useScopes(scopesVersion);

  // Filtered listings get their own cache key, so the unfiltered one App warms on hover
  // still seeds the common case and a subtree listing never serves the wrong folder.
  const key = scopeSel ? `memories:${scopeSel.path}` : "memories";
  const [memories, setMemories] = useState<Memory[] | null>(() => cachedData<Memory[]>(key));
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<MemoryType | "all">("all");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moveTarget, setMoveTarget] = useState("");
  const [moving, setMoving] = useState(false);

  const load = useCallback(() => {
    setMemories(cachedData<Memory[]>(key));
    prefetch(key, () => api.memories(scopeSel?.path))
      .then(setMemories)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [key, scopeSel]);
  // Mutations refetch through the cache-busting path so their refresh can never serve
  // the pre-edit copy back.
  const reload = useCallback(() => {
    refetch(key, () => api.memories(scopeSel?.path))
      .then(setMemories)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [key, scopeSel]);
  useEffect(load, [load]);

  // A mutation changed rows, so both the list and the sidebar counts are stale.
  const changed = useCallback(() => {
    reload();
    setTreeVersion((v) => v + 1);
  }, [reload]);

  async function moveSelected() {
    if (selected.size === 0 || moveTarget === "") return;
    setMoving(true);
    setError(null);
    try {
      const { moved } = await api.moveMemories([...selected], moveTarget);
      toastDone(`moved ${moved} ${moved === 1 ? "memory" : "memories"}`);
      setSelected(new Set());
      setMoveTarget("");
      changed();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMoving(false);
    }
  }

  const counts = new Map<MemoryType, number>();
  for (const m of memories ?? []) {
    const t = m.memoryType as MemoryType;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const shown = (memories ?? [])
    .filter((m) => filter === "all" || m.memoryType === filter)
    .filter((m) => tagFilter === null || (m.tags ?? []).includes(tagFilter));

  return (
    <div className="scopeLayout">
      <ScopeTree
        selected={scopeSel}
        onSelect={(sel) => {
          setScopeSel(sel);
          setSelected(new Set());
        }}
        count="memories"
        refreshKey={treeVersion}
        onChanged={() => setScopesVersion((v) => v + 1)}
      />
      <div className="panel">
        <div className="panelInner">
          <h2 className="sectionTitle">Save a memory</h2>
          <SaveMemoryCard onSaved={changed} />

          <h2 className="sectionTitle">Recall</h2>
          <RecallCard only="memory" />

          <h2 className="sectionTitle">Memories{memories ? `; ${memories.length} active` : ""}</h2>

          {error && <div className="notice noticeError">{error}</div>}
          {!memories && !error && <div className="spin">loading…</div>}

          {memories && memories.length === 0 && (
            <p style={{ color: "var(--text-faint)" }}>
              {scopeSel
                ? `No memories in ${scopeSel.label} yet.`
                : "No memories yet. Save one from the Console tab, or ask your agent to. " +
                  "Everything it remembers shows up here."}
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
              {/* The active filters, visibly clearable: the folder from the sidebar and the
                  tag from any card's chip. */}
              {scopeSel && (
                <button
                  type="button"
                  className="chip chipActive"
                  title="clear the folder filter"
                  onClick={() => setScopeSel(null)}
                >
                  folder: {scopeSel.label} ×
                </button>
              )}
              {tagFilter && (
                <button
                  type="button"
                  className="chip chipActive"
                  title="clear the tag filter"
                  onClick={() => setTagFilter(null)}
                >
                  tag: {tagFilter} ×
                </button>
              )}
            </div>
          )}

          {selected.size > 0 && (
            <div className="bulkBar">
              <span className="bulkCount">{selected.size} selected</span>
              <ScopePicker
                options={scopes ? flattenScopes(scopes) : []}
                value={moveTarget}
                onChange={setMoveTarget}
                placeholder="move to folder…"
                disabled={moving}
              />
              <button
                type="button"
                className="btn btnPrimary"
                disabled={moving || moveTarget === ""}
                onClick={moveSelected}
              >
                {moving ? "moving…" : "Move"}
              </button>
              <button
                type="button"
                className="btn btnGhost"
                disabled={moving}
                onClick={() => setSelected(new Set())}
              >
                clear
              </button>
            </div>
          )}

          {shown.map((m) => (
            <MemoryCard
              key={m.id}
              m={m}
              onChanged={changed}
              checked={selected.has(m.id)}
              onToggle={() =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(m.id)) next.delete(m.id);
                  else next.add(m.id);
                  return next;
                })
              }
              onTag={(t) => setTagFilter((cur) => (cur === t ? null : t))}
            />
          ))}

          {memories && memories.length > 0 && shown.length === 0 && (
            <p style={{ color: "var(--text-faint)" }}>Nothing matches the current filters.</p>
          )}
        </div>
      </div>
    </div>
  );
}
