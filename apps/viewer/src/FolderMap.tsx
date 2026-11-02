import { useMemo, useState } from "react";
import type { ScopeNode } from "./api";
import { type ScopeSelection, selectionFor } from "./ScopeTree";

// The folders as a field of hexagons: each one's area grows with how much it holds, so where
// the memory mass sits shows at a glance. Hover names a folder; clicking one with subfolders
// steps inside it, clicking a leaf opens it in the list. One level at a time, because the
// whole tree at once lets one big folder swallow the field or shatters it into specks.

type Count = "memories" | "documents";

interface Cell {
  node: ScopeNode;
  /** Items in this folder and everything under it. */
  total: number;
  /** True for the parent's own items, shown beside its subfolders. */
  own: boolean;
  x: number;
  y: number;
  r: number;
}

function subtotal(node: ScopeNode, count: Count): number {
  return node[count] + node.children.reduce((sum, c) => sum + subtotal(c, count), 0);
}

// Area, not width, tracks the count: a folder with four times the memories looks four times
// as big. A floor keeps an empty folder visible and clickable.
function radiusFor(total: number): number {
  return 10 + Math.sqrt(total) * 6;
}

// Biggest first, each next one on the nearest free spot of a spiral around the centre. A
// circle of the hexagon's outer radius stands in for it, plus a gap, so neighbours never touch.
// Deterministic: the same folders always land in the same places.
function pack(items: Omit<Cell, "x" | "y">[]): Cell[] {
  const placed: Cell[] = [];
  const gap = 6;
  for (const item of [...items].sort((a, b) => b.r - a.r)) {
    if (placed.length === 0) {
      placed.push({ ...item, x: 0, y: 0 });
      continue;
    }
    let spot = { x: 0, y: 0 };
    for (let step = 0; step < 20000; step++) {
      const angle = step * 0.35;
      const dist = 2 + step * 0.9;
      const x = Math.cos(angle) * dist;
      const y = Math.sin(angle) * dist * 0.8;
      const free = placed.every((p) => Math.hypot(p.x - x, p.y - y) >= p.r + item.r + gap);
      if (free) {
        spot = { x, y };
        break;
      }
    }
    placed.push({ ...item, ...spot });
  }
  return placed;
}

// Flat-topped, like the sketch it comes from.
function hexPoints(x: number, y: number, r: number): string {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i;
    return `${(x + r * Math.cos(a)).toFixed(1)},${(y + r * Math.sin(a)).toFixed(1)}`;
  }).join(" ");
}

export function FolderMap({
  scopes,
  count,
  selected,
  onOpen,
}: {
  scopes: ScopeNode[];
  count: Count;
  selected: ScopeSelection | null;
  /** Open a folder in the list view. */
  onOpen: (sel: ScopeSelection) => void;
}) {
  const [trail, setTrail] = useState<ScopeNode[]>([]);
  const [hover, setHover] = useState<Cell | null>(null);
  const parent = trail.at(-1) ?? null;

  const cells = useMemo(() => {
    const level = parent ? parent.children : scopes;
    const items = level.map((node) => {
      const total = subtotal(node, count);
      return { node, total, own: false, r: radiusFor(total) };
    });
    // A parent's own items sit beside its subfolders, or they would vanish from the map.
    if (parent && parent[count] > 0) {
      items.push({ node: parent, total: parent[count], own: true, r: radiusFor(parent[count]) });
    }
    return pack(items);
  }, [parent, scopes, count]);

  const view = useMemo(() => {
    const pad = 12;
    const minX = Math.min(...cells.map((c) => c.x - c.r)) - pad;
    const minY = Math.min(...cells.map((c) => c.y - c.r)) - pad;
    const maxX = Math.max(...cells.map((c) => c.x + c.r)) + pad;
    const maxY = Math.max(...cells.map((c) => c.y + c.r)) + pad;
    return { minX, minY, w: maxX - minX, h: maxY - minY };
  }, [cells]);

  function click(cell: Cell) {
    if (!cell.own && cell.node.children.length > 0) {
      // A folder that only wraps one subfolder (Work > projects) would show a single hexagon;
      // step through such wrappers to the first level with a real choice.
      const next = [...trail, cell.node];
      let last = cell.node;
      while (last.children.length === 1 && last[count] === 0) {
        last = last.children[0] as ScopeNode;
        next.push(last);
      }
      setTrail(next);
      setHover(null);
      return;
    }
    onOpen(selectionFor(cell.node, scopes));
  }

  const noun = count === "memories" ? "memories" : "documents";
  return (
    <div className="folderMap">
      <div className="folderMapCrumbs">
        <button type="button" className="metaAction" onClick={() => setTrail([])}>
          all folders
        </button>
        {trail.map((n, i) => (
          <span key={n.id}>
            {" › "}
            <button
              type="button"
              className="metaAction"
              onClick={() => setTrail(trail.slice(0, i + 1))}
            >
              {n.name}
            </button>
          </span>
        ))}
        {parent && (
          <button
            type="button"
            className="btn folderMapOpen"
            onClick={() => onOpen(selectionFor(parent, scopes))}
          >
            open {parent.name} in the list
          </button>
        )}
      </div>
      {cells.length === 0 ? (
        <p className="folderMapEmpty">No folders here.</p>
      ) : (
        <svg
          className="folderMapField"
          viewBox={`${view.minX} ${view.minY} ${view.w} ${view.h}`}
          role="img"
          aria-label={`Folders sized by ${noun}`}
        >
          <defs>
            <linearGradient id="folderMapSelected" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#5b9dff" />
              <stop offset="48%" stopColor="#2f74ea" />
              <stop offset="52%" stopColor="#1f62d6" />
              <stop offset="100%" stopColor="#1d5bc8" />
            </linearGradient>
          </defs>
          {cells.map((c) => {
            const isSelected = !c.own && selected?.id === c.node.id;
            // Counts print inside the hexagons big enough to hold them; names stay on hover.
            const showCount = c.r >= 22;
            return (
              // biome-ignore lint/a11y/useSemanticElements: an SVG shape cannot be a <button>
              <g
                key={c.own ? `${c.node.id}:own` : c.node.id}
                className={`folderHex ${isSelected ? "folderHexSelected" : ""} ${
                  c.own ? "folderHexOwn" : ""
                }`}
                role="button"
                tabIndex={0}
                aria-label={`${c.own ? `${c.node.name} itself` : c.node.name}: ${c.total} ${noun}`}
                onClick={() => click(c)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    click(c);
                  }
                }}
                onMouseEnter={() => setHover(c)}
                onMouseLeave={() => setHover((h) => (h === c ? null : h))}
                onFocus={() => setHover(c)}
                onBlur={() => setHover((h) => (h === c ? null : h))}
              >
                <polygon points={hexPoints(c.x, c.y, c.r)} />
                {showCount && (
                  <text
                    x={c.x}
                    y={c.y}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={Math.min(c.r * 0.42, 28)}
                  >
                    {c.total}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      <div className="folderMapHover" aria-live="polite">
        {hover ? (
          <>
            <strong>{hover.own ? `${hover.node.name} (its own)` : hover.node.name}</strong>{" "}
            {hover.total} {noun}
            {!hover.own && hover.node.children.length > 0 && "; click to look inside"}
          </>
        ) : (
          `Bigger hexagons hold more ${noun}. Hover one to see its name.`
        )}
      </div>
    </div>
  );
}

export type FolderView = "list" | "map";

/** List or map, remembered per tab in this browser. List is the default. */
export function useFolderView(tab: Count): [FolderView, (v: FolderView) => void] {
  const key = `memloom:folder-view:${tab}`;
  const [mode, setMode] = useState<FolderView>(() => {
    try {
      return localStorage.getItem(key) === "map" ? "map" : "list";
    } catch {
      return "list";
    }
  });
  const set = (v: FolderView) => {
    setMode(v);
    try {
      localStorage.setItem(key, v);
    } catch {
      // A blocked storage only means the choice is not remembered.
    }
  };
  return [mode, set];
}

export function FolderViewToggle({
  mode,
  onChange,
}: {
  mode: FolderView;
  onChange: (v: FolderView) => void;
}) {
  return (
    <div className="graphSegment folderViewToggle">
      {(["list", "map"] as const).map((v) => (
        <button
          key={v}
          type="button"
          className={`graphSegmentBtn ${mode === v ? "graphSegmentBtnActive" : ""}`}
          aria-pressed={mode === v}
          onClick={() => onChange(v)}
        >
          {v}
        </button>
      ))}
    </div>
  );
}
