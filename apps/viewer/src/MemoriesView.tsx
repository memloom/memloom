import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, type Memory, type MemoryType, type TrashedMemory } from "./api";
import { RecallCard, SaveMemoryCard } from "./cards";
import { cachedData, prefetch, refetch } from "./prefetch";
import { flattenScopes, ScopePicker, type ScopeSelection, ScopeTree, useScopes } from "./ScopeTree";
import { toastDone } from "./toast";

// Browse every active memory, newest first. The reading counterpart to the Console's
// query-driven recall. Each memory can be edited (a manual, human action that appends a new
// version), its version history expanded, or removed (two-step confirm; the whole version
// chain moves to Recently removed, restorable for 30 days). The folder sidebar narrows the list to one subtree, and
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
      toastDone("moved to Recently removed");
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

function daysLeft(expiresAt: string): string {
  const days = Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 86_400_000));
  return days <= 1 ? "deleted for good tomorrow" : `deleted for good in ${days} days`;
}

// Removed memories, kept 30 days. Reached from the row pinned to the foot of the folder
// sidebar, so it is one click away however long the memory list gets. Restore puts a memory
// back with its versions, links and attachments; delete forever and empty trash are two-click,
// like remove.
function RecentlyRemoved({
  items,
  error,
  folderOf,
  onChanged,
  onBack,
}: {
  items: TrashedMemory[] | null;
  error: string | null;
  folderOf: (scopeId: string | null) => string;
  onChanged: () => void;
  onBack: () => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [arming, setArming] = useState<string | null>(null);

  async function act(id: string, run: () => Promise<unknown>, done: string) {
    setBusy(id);
    setErr(null);
    try {
      await run();
      toastDone(done);
      setArming(null);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // A second click on the same button confirms; leaving it disarms.
  function armed(key: string, run: () => void) {
    if (arming !== key) setArming(key);
    else run();
  }

  const count = items?.length ?? 0;
  return (
    <>
      <div className="trashHead">
        <h2 className="sectionTitle">Recently removed{items ? `; ${count}` : ""}</h2>
        <button type="button" className="metaAction" onClick={onBack}>
          back to memories
        </button>
      </div>
      <p className="trashNote">
        Removed memories wait here for 30 days, then they and their attachments are deleted for
        good. Agents and recall don't see them.
      </p>
      {(err ?? error) && <div className="notice noticeError">{err ?? error}</div>}
      {!items && !error && <div className="spin">loading…</div>}
      {items && count === 0 && <p className="trashNote">Nothing removed.</p>}
      {count > 1 && (
        <button
          type="button"
          className="btn btnGhost trashEmpty"
          disabled={busy !== null}
          onBlur={() => setArming(null)}
          onClick={() =>
            armed("*", () => act("*", () => api.emptyTrash(), `deleted ${count} memories for good`))
          }
        >
          {arming === "*" ? `confirm: delete all ${count} for good` : "empty trash"}
        </button>
      )}
      {items?.map((t) => (
        <div key={t.rootId} className="recallItem trashItem">
          <div className="recallTitle">
            <span className="typeTag">{t.memoryType}</span>
            {t.content}
            {t.versions > 1 && <span className="versionTag">{t.versions} versions</span>}
          </div>
          <div className="chipLine">
            <span className="scopeTag">{folderOf(t.scopeId)}</span>
            {t.attachments > 0 && (
              <span className="scopeTag">
                {t.attachments} {t.attachments === 1 ? "attachment" : "attachments"}
              </span>
            )}
          </div>
          <div className="recallMeta">
            removed {new Date(t.deletedAt).toLocaleString()}; {daysLeft(t.expiresAt)}
            <button
              type="button"
              className="metaAction"
              disabled={busy === t.rootId}
              onClick={() => act(t.rootId, () => api.restoreMemory(t.rootId), "restored")}
            >
              restore
            </button>
            <button
              type="button"
              className="metaAction metaActionDanger"
              disabled={busy === t.rootId}
              onBlur={() => setArming(null)}
              onClick={() =>
                armed(t.rootId, () =>
                  act(t.rootId, () => api.deleteForever(t.rootId), "deleted for good"),
                )
              }
            >
              {arming === t.rootId ? "confirm delete forever" : "delete forever"}
            </button>
          </div>
        </div>
      ))}
    </>
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
  const [trashVersion, setTrashVersion] = useState(0);
  // The panel shows either the memory list or the trash; the sidebar's pinned row switches.
  const [showTrash, setShowTrash] = useState(false);
  const [trash, setTrash] = useState<TrashedMemory[] | null>(null);
  const [trashError, setTrashError] = useState<string | null>(null);

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
  // A removal also lands in Recently removed.
  const changed = useCallback(() => {
    reload();
    setTreeVersion((v) => v + 1);
    setTrashVersion((v) => v + 1);
  }, [reload]);

  // Loaded up front, not on opening: the sidebar row shows the count.
  // biome-ignore lint/correctness/useExhaustiveDependencies: trashVersion is the trigger
  useEffect(() => {
    api
      .trash()
      .then((items) => {
        setTrash(items);
        setTrashError(null);
      })
      .catch((err) => setTrashError(err instanceof Error ? err.message : String(err)));
  }, [trashVersion]);

  const folderOf = (scopeId: string | null) =>
    (scopeId && scopes ? flattenScopes(scopes).find((s) => s.id === scopeId)?.path : null) ??
    "uncategorized";

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
        selected={showTrash ? null : scopeSel}
        inactive={showTrash}
        onSelect={(sel) => {
          setShowTrash(false);
          setScopeSel(sel);
          setSelected(new Set());
        }}
        count="memories"
        refreshKey={treeVersion}
        onChanged={() => setScopesVersion((v) => v + 1)}
        footer={
          <div className={`scopeRow trashRow ${showTrash ? "scopeRowActive" : ""}`}>
            <Trash2 className="trashIcon" size={13} strokeWidth={1.75} aria-hidden="true" />
            <button type="button" className="scopeName" onClick={() => setShowTrash(true)}>
              recently removed
            </button>
            <span className="scopeCount">{trash?.length ?? ""}</span>
          </div>
        }
      />
      <div className="panel">
        <div className="panelInner">
          {showTrash ? (
            <RecentlyRemoved
              items={trash}
              error={trashError}
              folderOf={folderOf}
              onChanged={changed}
              onBack={() => setShowTrash(false)}
            />
          ) : (
            <>
              <h2 className="sectionTitle">Save a memory</h2>
              <SaveMemoryCard onSaved={changed} />

              <h2 className="sectionTitle">Recall</h2>
              <RecallCard only="memory" />

              <h2 className="sectionTitle">
                Memories{memories ? `; ${memories.length} active` : ""}
              </h2>

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
            </>
          )}
        </div>
      </div>
    </div>
  );
}
