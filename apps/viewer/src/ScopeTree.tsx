import { ChevronDown, ChevronRight } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { api, type ScopeNode } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { cachedData, prefetch, refetch } from "./prefetch";

// The folder sidebar shared by the Memories, Documents, and Graph views. One tree, three
// consumers: selecting a folder narrows the active view to that folder's subtree, and the
// management affordances (create, rename, describe, move, delete) live here because folders
// are the user's to manage; agents can only file things into them.

/**
 * One selected folder, resolved to everything a view needs to filter by. The daemon's
 * scope params take `path`; client-side filters (documents, graph) use the id set.
 */
export interface ScopeSelection {
  id: string;
  /** Addressable slug path ("projects/memloom"), what the daemon's scope params take. */
  path: string;
  /** Display path ("Projects > memloom") for filter chips. */
  label: string;
  /** The folder plus every descendant. */
  ids: string[];
  /** True when the subtree covers 'uncategorized': legacy NULL scope ids count as in it. */
  includeUnscoped: boolean;
}

/** One folder flattened for a <select>: the move targets and the pickers. */
export interface ScopeOption {
  id: string;
  path: string;
  name: string;
  label: string;
  depth: number;
  kind: "user" | "system";
}

export function flattenScopes(nodes: ScopeNode[]): ScopeOption[] {
  const out: ScopeOption[] = [];
  const walk = (list: ScopeNode[], depth: number, parentLabel: string) => {
    for (const n of list) {
      const label = parentLabel ? `${parentLabel} > ${n.name}` : n.name;
      out.push({ id: n.id, path: n.path, name: n.name, label, depth, kind: n.kind });
      walk(n.children, depth + 1, label);
    }
  };
  walk(nodes, 0, "");
  return out;
}

/**
 * The shared read behind the tree and the pickers. Same prefetch key everywhere, so the
 * sidebar and a view's move picker cost one request between them. Bump `version` after a
 * mutation to bust the cache; version 0 (mount) revalidates through it instead.
 */
export function useScopes(version = 0): {
  scopes: ScopeNode[] | null;
  error: string | null;
} {
  const [scopes, setScopes] = useState<ScopeNode[] | null>(() => cachedData<ScopeNode[]>("scopes"));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    (version === 0 ? prefetch : refetch)("scopes", api.scopes)
      .then((next) => {
        setScopes(next);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [version]);
  return { scopes, error };
}

/** A folder dropdown over slug paths. Empty value shows the placeholder and does nothing. */
export function ScopePicker({
  options,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  options: ScopeOption[];
  value: string;
  onChange: (path: string) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  return (
    <select
      className="scopeSelect"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.id} value={o.path}>
          {`${"  ".repeat(o.depth)}${o.name}`}
        </option>
      ))}
    </select>
  );
}

function collectIds(node: ScopeNode): string[] {
  return [node.id, ...node.children.flatMap(collectIds)];
}

type EditMode = "rename" | "describe" | "new" | "move";

export function ScopeTree({
  selected,
  onSelect,
  count,
  manage = true,
  refreshKey = 0,
  onChanged,
}: {
  selected: ScopeSelection | null;
  onSelect: (sel: ScopeSelection | null) => void;
  /** Which per-folder count to show next to each name. */
  count: "memories" | "documents";
  /** False hides the management affordances (the graph panel only filters). */
  manage?: boolean;
  /** Parents bump this after a mutation elsewhere moved rows between folders. */
  refreshKey?: number;
  /** Fires after any folder mutation here, so parents can refresh their pickers. */
  onChanged?: () => void;
}) {
  // Internal bumps (a folder was created/renamed here) and external ones share one version.
  const [localVersion, setLocalVersion] = useState(0);
  const { scopes, error: loadError } = useScopes(refreshKey + localVersion);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ id: string; mode: EditMode } | null>(null);
  const [draft, setDraft] = useState("");
  const [moveTarget, setMoveTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ScopeNode | null>(null);
  const [creatingTop, setCreatingTop] = useState(false);

  const options = useMemo(() => (scopes ? flattenScopes(scopes) : []), [scopes]);
  const uncategorizedId = useMemo(
    () => scopes?.find((n) => n.kind === "system" && n.path === "uncategorized")?.id ?? null,
    [scopes],
  );

  const makeSelection = useCallback(
    (node: ScopeNode): ScopeSelection => {
      const ids = collectIds(node);
      const label = options.find((o) => o.id === node.id)?.label ?? node.name;
      return {
        id: node.id,
        path: node.path,
        label,
        ids,
        includeUnscoped: uncategorizedId !== null && ids.includes(uncategorizedId),
      };
    },
    [options, uncategorizedId],
  );

  // A reload can invalidate the current selection: the folder was deleted (clear it) or
  // renamed/moved (its path and label changed; hand the caller the fresh resolution so its
  // server filter keeps pointing at the same folder).
  useEffect(() => {
    if (!scopes || !selected) return;
    const find = (list: ScopeNode[]): ScopeNode | null => {
      for (const n of list) {
        if (n.id === selected.id) return n;
        const hit = find(n.children);
        if (hit) return hit;
      }
      return null;
    };
    const node = find(scopes);
    if (!node) {
      onSelect(null);
      return;
    }
    const fresh = makeSelection(node);
    if (
      fresh.path !== selected.path ||
      fresh.label !== selected.label ||
      fresh.ids.join() !== selected.ids.join()
    ) {
      onSelect(fresh);
    }
  }, [scopes, selected, makeSelection, onSelect]);

  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await run();
      setEditing(null);
      setCreatingTop(false);
      setDraft("");
      setMoveTarget("");
      setLocalVersion((v) => v + 1);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function startEdit(node: ScopeNode, mode: EditMode) {
    setEditing({ id: node.id, mode });
    setMoveTarget("");
    setDraft(mode === "rename" ? node.name : mode === "describe" ? (node.description ?? "") : "");
  }

  function submitEdit(node: ScopeNode) {
    if (!editing) return;
    const text = draft.trim();
    if (editing.mode === "rename") {
      if (!text || text === node.name) {
        setEditing(null);
        return;
      }
      void act(() => api.updateScope(node.id, { name: text }));
    } else if (editing.mode === "describe") {
      if (text === (node.description ?? "")) {
        setEditing(null);
        return;
      }
      void act(() => api.updateScope(node.id, { description: text.length > 0 ? text : null }));
    } else if (editing.mode === "new") {
      if (!text) {
        setEditing(null);
        return;
      }
      void act(() => api.createScope(`${node.path}/${text}`));
    }
  }

  const totals = useMemo(() => {
    let n = 0;
    const walk = (list: ScopeNode[]) => {
      for (const node of list) {
        n += node[count];
        walk(node.children);
      }
    };
    if (scopes) walk(scopes);
    return n;
  }, [scopes, count]);

  const renderNode = (node: ScopeNode): ReactNode => {
    const isCollapsed = collapsed.has(node.id);
    const isActive = selected?.id === node.id;
    const isEditing = editing?.id === node.id ? editing.mode : null;
    // Emptiness for delete considers everything the server checks, not just the count on
    // display: subfolders, memories, and documents all block a delete.
    const empty = node.children.length === 0 && node.memories === 0 && node.documents === 0;
    // Move targets: any user folder that is not this one or inside it, plus the top level.
    const subtree = new Set(collectIds(node));
    const parents = options.filter((o) => o.kind === "user" && !subtree.has(o.id));
    return (
      <div key={node.id}>
        <div
          className={`scopeRow ${isActive ? "scopeRowActive" : ""} ${
            node.kind === "system" ? "scopeRowSystem" : ""
          }`}
        >
          {node.children.length > 0 ? (
            <button
              type="button"
              className="scopeChevron"
              aria-label={isCollapsed ? "Expand folder" : "Collapse folder"}
              onClick={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(node.id)) next.delete(node.id);
                  else next.add(node.id);
                  return next;
                })
              }
            >
              {isCollapsed ? (
                <ChevronRight size={13} strokeWidth={1.75} />
              ) : (
                <ChevronDown size={13} strokeWidth={1.75} />
              )}
            </button>
          ) : (
            <span className="scopeChevron" />
          )}
          {isEditing === "rename" ? (
            <input
              className="scopeInput"
              value={draft}
              // biome-ignore lint/a11y/noAutofocus: the input appears in response to the user's own click to rename
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => submitEdit(node)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitEdit(node);
                if (e.key === "Escape") setEditing(null);
              }}
            />
          ) : (
            <button
              type="button"
              className="scopeName"
              title={node.description ?? node.path}
              onClick={() => onSelect(isActive ? null : makeSelection(node))}
            >
              {node.name}
            </button>
          )}
          <span className="scopeCount">{node[count]}</span>
        </div>
        {isActive && node.description && <div className="scopeDesc">{node.description}</div>}
        {/* System folders (uncategorized, global) are fixtures: no renaming, no children,
            nothing to manage, so the tools row only appears on the user's own folders. */}
        {manage && isActive && !isEditing && node.kind === "user" && (
          <div className="scopeTools">
            <button type="button" className="metaAction" onClick={() => startEdit(node, "new")}>
              new subfolder
            </button>
            <button type="button" className="metaAction" onClick={() => startEdit(node, "rename")}>
              rename
            </button>
            <button
              type="button"
              className="metaAction"
              onClick={() => startEdit(node, "describe")}
            >
              describe
            </button>
            <button type="button" className="metaAction" onClick={() => startEdit(node, "move")}>
              move
            </button>
            <button
              type="button"
              className="metaAction metaActionDanger"
              disabled={!empty}
              title={empty ? undefined : "only an empty folder can be deleted"}
              onClick={() => setConfirmDelete(node)}
            >
              delete
            </button>
          </div>
        )}
        {manage && (isEditing === "new" || isEditing === "describe") && (
          <div className="scopeEditRow">
            <input
              className="scopeInput"
              value={draft}
              // biome-ignore lint/a11y/noAutofocus: the input appears in response to the user's own click
              autoFocus
              placeholder={isEditing === "new" ? "subfolder name" : "what belongs in this folder"}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitEdit(node);
                if (e.key === "Escape") setEditing(null);
              }}
            />
            <button type="button" className="btn" disabled={busy} onClick={() => submitEdit(node)}>
              {isEditing === "new" ? "create" : "save"}
            </button>
          </div>
        )}
        {manage && isEditing === "move" && (
          <div className="scopeEditRow">
            <select
              className="scopeSelect"
              value={moveTarget}
              onChange={(e) => setMoveTarget(e.target.value)}
            >
              <option value="">move under…</option>
              <option value="__root__">(top level)</option>
              {parents.map((o) => (
                <option key={o.id} value={o.id}>
                  {`${"  ".repeat(o.depth)}${o.name}`}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn"
              disabled={busy || moveTarget === ""}
              onClick={() =>
                void act(() =>
                  api.moveScope(node.id, moveTarget === "__root__" ? null : moveTarget),
                )
              }
            >
              move
            </button>
            <button type="button" className="btn btnGhost" onClick={() => setEditing(null)}>
              cancel
            </button>
          </div>
        )}
        {!isCollapsed && node.children.length > 0 && (
          <div className="scopeKids">{node.children.map((c) => renderNode(c))}</div>
        )}
      </div>
    );
  };

  return (
    <aside className="scopeSidebar">
      <div className="scopeSidebarTitle">folders</div>
      {(error ?? loadError) && <div className="notice noticeError">{error ?? loadError}</div>}
      {!scopes && !loadError && <div className="spin">loading…</div>}
      {scopes && (
        <>
          <div className={`scopeRow ${selected === null ? "scopeRowActive" : ""}`}>
            <span className="scopeChevron" />
            <button type="button" className="scopeName" onClick={() => onSelect(null)}>
              all folders
            </button>
            <span className="scopeCount">{totals}</span>
          </div>
          {scopes.map((n) => renderNode(n))}
          {manage &&
            (creatingTop ? (
              <div className="scopeEditRow">
                <input
                  className="scopeInput"
                  value={draft}
                  // biome-ignore lint/a11y/noAutofocus: the input appears in response to the user's own click
                  autoFocus
                  placeholder="name, or a/nested/path"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && draft.trim()) {
                      void act(() => api.createScope(draft.trim()));
                    }
                    if (e.key === "Escape") setCreatingTop(false);
                  }}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={busy || draft.trim().length === 0}
                  onClick={() => void act(() => api.createScope(draft.trim()))}
                >
                  create
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="metaAction scopeNewTop"
                onClick={() => {
                  setDraft("");
                  setEditing(null);
                  setCreatingTop(true);
                }}
              >
                + new folder
              </button>
            ))}
        </>
      )}
      <ConfirmDialog
        open={confirmDelete !== null}
        title={`Delete "${confirmDelete?.name ?? ""}"?`}
        body="The folder is removed from the registry. It is empty, so no memories or documents are touched."
        confirmLabel="Delete folder"
        danger
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          const node = confirmDelete;
          setConfirmDelete(null);
          if (!node) return;
          void act(async () => {
            await api.deleteScope(node.id);
            if (selected?.id === node.id) onSelect(null);
          });
        }}
      />
    </aside>
  );
}
