import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Graph, ScopeNode } from "./api";
import { GraphView } from "./GraphView";
import { type ScopeSelection, selectionFor } from "./ScopeTree";

// The folders as a field of hexagons filling the panel: each one's area grows with how much it
// holds, so where the memory mass sits shows at a glance. Names and counts print on the
// hexagons big enough to carry them; hover any of them for a popup. Clicking a folder with
// subfolders zooms into it; clicking one without opens its memories as a graph, the same
// renderer as the Graph tab, limited to that folder. One level at a time, because the whole
// tree at once lets one big folder swallow the field or shatters it into specks.

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

/** A folder open as a graph: the whole subtree, or only a parent's own items. */
interface Leaf {
  node: ScopeNode;
  own: boolean;
}

// How long the zoom into a hexagon runs before the next level takes its place. Matches the
// transition and keyframes in styles.css.
const ZOOM_MS = 420;

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

function fit(name: string, chars: number): string {
  if (name.length <= chars) return name;
  return `${name.slice(0, Math.max(1, chars - 1))}…`;
}

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export function FolderMap({
  scopes,
  graph,
  count,
  selected,
  onOpen,
}: {
  scopes: ScopeNode[];
  /** The store's graph, for a folder opened as one. Null while it loads. */
  graph: Graph | null;
  count: Count;
  selected: ScopeSelection | null;
  /** Open a folder in the list view. */
  onOpen: (sel: ScopeSelection) => void;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [trail, setTrail] = useState<ScopeNode[]>([]);
  const [leaf, setLeaf] = useState<Leaf | null>(null);
  const [hover, setHover] = useState<{ cell: Cell; x: number; y: number } | null>(null);
  // "zoom" while the field flies into the clicked hexagon; "enter" / "back" while the next
  // level settles in from inside or from outside.
  const [motion, setMotion] = useState<
    { kind: "zoom"; x: number; y: number; k: number } | { kind: "enter" | "back" } | null
  >(null);
  const parent = trail.at(-1) ?? null;

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (motion?.kind !== "enter" && motion?.kind !== "back") return;
    const timer = setTimeout(() => setMotion(null), ZOOM_MS);
    return () => clearTimeout(timer);
  }, [motion]);

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

  // Unit space to pixels: centre the packing and scale it to fill the stage.
  const view = useMemo(() => {
    if (cells.length === 0 || size.w === 0) return { s: 1, cx: 0, cy: 0 };
    const minX = Math.min(...cells.map((c) => c.x - c.r));
    const minY = Math.min(...cells.map((c) => c.y - c.r));
    const maxX = Math.max(...cells.map((c) => c.x + c.r));
    const maxY = Math.max(...cells.map((c) => c.y + c.r));
    const s = Math.min(size.w / (maxX - minX), size.h / (maxY - minY)) * 0.9;
    return { s, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  }, [cells, size]);
  const px = (c: Cell) => ({
    x: (c.x - view.cx) * view.s + size.w / 2,
    y: (c.y - view.cy) * view.s + size.h / 2,
    r: c.r * view.s,
  });

  // Fly into the hexagon, then swap the level. Reduced motion swaps at once.
  function zoomInto(cell: Cell, then: () => void) {
    setHover(null);
    if (reducedMotion()) {
      then();
      return;
    }
    const p = px(cell);
    setMotion({ kind: "zoom", x: p.x, y: p.y, k: Math.max(size.w, size.h) / (p.r * 1.4) });
    setTimeout(() => {
      then();
      setMotion({ kind: "enter" });
    }, ZOOM_MS);
  }

  function goBack(nextTrail: ScopeNode[]) {
    setHover(null);
    setLeaf(null);
    setTrail(nextTrail);
    setMotion(reducedMotion() ? null : { kind: "back" });
  }

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
      zoomInto(cell, () => setTrail(next));
      return;
    }
    zoomInto(cell, () => setLeaf({ node: cell.node, own: cell.own }));
  }

  // A parent's own items open as just that folder, without the subfolders beside them.
  const leafSelection = (l: Leaf): ScopeSelection => {
    const sel = selectionFor(l.node, scopes);
    return l.own ? { ...sel, ids: [l.node.id] } : sel;
  };

  const noun = count === "memories" ? "memories" : "documents";
  const layerStyle =
    motion?.kind === "zoom"
      ? {
          transform: `translate(${size.w / 2}px, ${size.h / 2}px) scale(${motion.k}) translate(${-motion.x}px, ${-motion.y}px)`,
          opacity: 0,
        }
      : undefined;
  const layerClass = `folderMapLayer ${motion?.kind === "zoom" ? "folderMapZooming" : ""} ${
    motion?.kind === "enter" ? "folderMapEnter" : ""
  } ${motion?.kind === "back" ? "folderMapBack" : ""}`;

  return (
    <div className="folderMap">
      <div className="folderMapCrumbs">
        <button type="button" className="metaAction" onClick={() => goBack([])}>
          all folders
        </button>
        {trail.map((n, i) => (
          <span key={n.id}>
            {" › "}
            <button
              type="button"
              className="metaAction"
              onClick={() => goBack(trail.slice(0, i + 1))}
            >
              {n.name}
            </button>
          </span>
        ))}
        {leaf && (
          <span>
            {" › "}
            <strong>{leaf.own ? `${leaf.node.name} (its own)` : leaf.node.name}</strong>
          </span>
        )}
        {(leaf ?? parent) && (
          <button
            type="button"
            className="btn folderMapOpen"
            onClick={() => {
              const target = leaf ? leafSelection(leaf) : selectionFor(parent as ScopeNode, scopes);
              onOpen(target);
            }}
          >
            open in the list
          </button>
        )}
      </div>

      <div ref={stageRef} className="folderMapStage">
        {leaf ? (
          <div className={`folderMapGraph ${layerClass}`}>
            {graph ? (
              <GraphView graph={graph} active scope={leafSelection(leaf)} embedded />
            ) : (
              <div className="emptyState">loading…</div>
            )}
          </div>
        ) : cells.length === 0 ? (
          <p className="folderMapEmpty">No folders here.</p>
        ) : (
          <svg
            className="folderMapField"
            width={size.w}
            height={size.h}
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
            <g className={layerClass} style={layerStyle}>
              {cells.map((c) => {
                const p = px(c);
                const isSelected = !c.own && selected?.id === c.node.id;
                const name = c.own ? `${c.node.name} (its own)` : c.node.name;
                // Name and count where the hexagon can carry them; the popup covers the rest.
                const font = Math.min(Math.max(p.r * 0.2, 11), 22);
                const showName = p.r >= 36;
                const showCount = p.r >= 18;
                const chars = Math.floor((p.r * 1.5) / (font * 0.58));
                return (
                  // biome-ignore lint/a11y/useSemanticElements: an SVG shape cannot be a <button>
                  <g
                    key={c.own ? `${c.node.id}:own` : c.node.id}
                    className={`folderHex ${isSelected ? "folderHexSelected" : ""} ${
                      c.own ? "folderHexOwn" : ""
                    }`}
                    role="button"
                    tabIndex={0}
                    aria-label={`${name}: ${c.total} ${noun}`}
                    onClick={() => click(c)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        click(c);
                      }
                    }}
                    onMouseMove={(e) => {
                      const box = stageRef.current?.getBoundingClientRect();
                      if (!box) return;
                      setHover({ cell: c, x: e.clientX - box.left, y: e.clientY - box.top });
                    }}
                    onMouseLeave={() => setHover((h) => (h?.cell === c ? null : h))}
                    onFocus={() => setHover({ cell: c, x: p.x, y: p.y })}
                    onBlur={() => setHover((h) => (h?.cell === c ? null : h))}
                  >
                    <polygon points={hexPoints(p.x, p.y, p.r)} />
                    {showName && (
                      <text
                        className="folderHexName"
                        x={p.x}
                        y={p.y - font * 0.45}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={font}
                      >
                        {fit(name, chars)}
                      </text>
                    )}
                    {showCount && (
                      <text
                        className="folderHexCount"
                        x={p.x}
                        y={showName ? p.y + font * 0.75 : p.y}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={showName ? font * 0.8 : Math.min(p.r * 0.5, 12)}
                      >
                        {c.total}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
        )}

        {hover && !leaf && (
          <div
            className="folderMapPopup"
            style={{
              left: Math.min(hover.x + 14, size.w - 220),
              top: Math.max(hover.y - 12, 8),
            }}
          >
            <strong>
              {hover.cell.own ? `${hover.cell.node.name} (its own)` : hover.cell.node.name}
            </strong>
            <span>
              {hover.cell.total} {noun}
            </span>
            <span className="folderMapPopupHint">
              {!hover.cell.own && hover.cell.node.children.length > 0
                ? "click to go inside"
                : `click to see its ${noun} as a graph`}
            </span>
          </div>
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
