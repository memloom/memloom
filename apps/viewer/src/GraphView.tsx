import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import { api, type DocumentChunks, type Graph } from "./api";

// The memory graph, ported from a production canvas pixel-motif: memories draw as
// SQUARES (sky), entities as CIRCLES (purple), context documents as DIAMONDS (emerald), so
// node kind reads at a glance. Clicking a document expands it into its chunks — smaller
// emerald SQUARES (content is square; only entities are circles) — swapping the rolled-up
// document edges for the real chunk-level ones. Labels are monospace and fade in with zoom;
// hovering highlights a node and its neighbors.

const MEMORY_COLOR = "#38bdf8";
const ENTITY_COLOR = "#c084fc";
const DOCUMENT_COLOR = "#34d399";
const CHUNK_COLOR = "#6ee7b7";
const LINK_BASE = "rgba(148, 163, 184, 0.45)";
const LINK_BY_RELATION: Record<string, string> = {
  mentions: "rgba(192, 132, 252, 0.5)",
  mention: "rgba(192, 132, 252, 0.5)",
  replaces: "rgba(245, 158, 11, 0.6)",
  distinct: "rgba(45, 212, 191, 0.5)",
  chunk: "rgba(52, 211, 153, 0.45)",
};
const LABEL_THRESHOLD = 0.9; // globalScale where labels start fading in
const MIN_ZOOM = 0.14;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.4;

type NodeKind = "memory" | "entity" | "document" | "chunk";

interface Node {
  id: string;
  kind: NodeKind;
  label: string;
  full: string;
  size: number;
  x?: number;
  y?: number;
}

interface Link {
  source: string | Node;
  target: string | Node;
  relation: string;
  weight?: number;
}

type Selected = { kind: NodeKind; title: string; body: string; id: string } | null;

const NODE_COLOR: Record<NodeKind, string> = {
  memory: MEMORY_COLOR,
  entity: ENTITY_COLOR,
  document: DOCUMENT_COLOR,
  chunk: CHUNK_COLOR,
};

function endpointId(endpoint: string | Node): string {
  return typeof endpoint === "string" ? endpoint : endpoint.id;
}

// One path per node kind: square (memory, chunk — content is square), circle (entity),
// diamond (document). The diamond is widened slightly so its visual weight matches the
// square's.
function traceNode(
  ctx: CanvasRenderingContext2D,
  kind: NodeKind,
  x: number,
  y: number,
  r: number,
): void {
  ctx.beginPath();
  if (kind === "entity") {
    ctx.arc(x, y, r, 0, Math.PI * 2);
  } else if (kind === "document") {
    const d = r * 1.25;
    ctx.moveTo(x, y - d);
    ctx.lineTo(x + d, y);
    ctx.lineTo(x, y + d);
    ctx.lineTo(x - d, y);
    ctx.closePath();
  } else {
    ctx.rect(x - r, y - r, r * 2, r * 2);
  }
}

export function GraphView({ graph }: { graph: Graph }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // react-force-graph's methods surface (zoom, zoomToFit, ...) — kept loose on purpose.
  // biome-ignore lint/suspicious/noExplicitAny: untyped imperative handle from the lib
  const fgRef = useRef<any>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [selected, setSelected] = useState<Selected>(null);
  // Documents expanded to chunk granularity: docId -> the fetched drill-down. Fetched fresh
  // on every expand so a re-ingested file never shows stale chunks.
  const [expanded, setExpanded] = useState<Map<string, DocumentChunks>>(new Map());
  const hoverRef = useRef<{ id: string | null; neighbors: Set<string> }>({
    id: null,
    neighbors: new Set(),
  });

  const { data, neighborMap } = useMemo(() => {
    // Ignore expansions of documents that no longer exist (removed between refreshes).
    const docIds = new Set(graph.documents.map((d) => d.id));
    const openDocs = [...expanded].filter(([id]) => docIds.has(id));
    const openIds = new Set(openDocs.map(([id]) => id));

    const nodes: Node[] = [
      ...graph.memories.map((m) => ({
        id: m.id,
        kind: "memory" as const,
        label: m.canonical ?? m.content,
        full: m.content,
        size: 6,
      })),
      ...graph.entities.map((e) => ({
        id: e.id,
        kind: "entity" as const,
        label: e.name,
        full: `${e.name} (${e.entityType})`,
        size: 7,
      })),
      ...graph.documents.map((d) => ({
        id: d.id,
        kind: "document" as const,
        label: d.title,
        full: d.path,
        size: 8,
      })),
      ...openDocs.flatMap(([, dc]) =>
        dc.chunks.map((c) => ({
          id: c.id,
          kind: "chunk" as const,
          label: c.headingPath ?? `#${c.chunkIndex + 1}`,
          full: c.content,
          size: 4.5,
        })),
      ),
    ];
    const ids = new Set(nodes.map((n) => n.id));
    const links: Link[] = [
      // An expanded document swaps its rolled-up mention edges for the chunk-level truth.
      ...graph.edges
        .filter((e) => !(openIds.has(e.from) && e.relation === "mention"))
        .filter((e) => ids.has(e.from) && ids.has(e.to))
        .map((e) => ({ source: e.from, target: e.to, relation: e.relation, weight: e.weight })),
      ...openDocs.flatMap(([docId, dc]) => [
        ...dc.chunks.map((c) => ({ source: docId, target: c.id, relation: "chunk" })),
        ...dc.edges
          .filter((e) => ids.has(e.from) && ids.has(e.to))
          .map((e) => ({ source: e.from, target: e.to, relation: e.relation })),
      ]),
    ];

    const neighbors = new Map<string, Set<string>>();
    for (const l of links) {
      const s = endpointId(l.source);
      const t = endpointId(l.target);
      if (!neighbors.has(s)) neighbors.set(s, new Set());
      if (!neighbors.has(t)) neighbors.set(t, new Set());
      neighbors.get(s)?.add(t);
      neighbors.get(t)?.add(s);
    }
    return { data: { nodes, links }, neighborMap: neighbors };
  }, [graph, expanded]);

  useEffect(() => {
    if (!wrapRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ width: Math.max(320, rect.width), height: Math.max(320, rect.height) });
    });
    observer.observe(wrapRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => fgRef.current?.zoomToFit?.(600, 90), 250);
    return () => clearTimeout(t);
  }, []);

  const handleHover = useCallback(
    (node: Node | null) => {
      hoverRef.current = node
        ? { id: node.id, neighbors: neighborMap.get(node.id) ?? new Set() }
        : { id: null, neighbors: new Set() };
      if (wrapRef.current) wrapRef.current.style.cursor = node ? "pointer" : "default";
    },
    [neighborMap],
  );

  const handleClick = useCallback(
    (node: Node) => {
      setSelected({
        kind: node.kind,
        title: node.label,
        body: node.full,
        id: node.id,
      });
      if (node.kind !== "document") return;
      // Toggle: collapse an open document, otherwise fetch its chunks and expand.
      if (expanded.has(node.id)) {
        const next = new Map(expanded);
        next.delete(node.id);
        setExpanded(next);
        return;
      }
      void api
        .documentChunks(node.id)
        .then((dc) => setExpanded((prev) => new Map(prev).set(node.id, dc)))
        .catch(() => {}); // daemon hiccup — stay collapsed, next click retries
    },
    [expanded],
  );

  const nodeCanvasObject = useCallback(
    (node: Node, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const hover = hoverRef.current;
      const isFocused = hover.id === node.id;
      const isNeighbor = hover.neighbors.has(node.id);
      const isSelected = selected?.id === node.id;
      const dim = hover.id !== null && !isFocused && !isNeighbor && !isSelected;

      const color = NODE_COLOR[node.kind];
      const radius = node.size * (isSelected ? 1.25 : isFocused ? 1.15 : 1);
      const nx = node.x ?? 0;
      const ny = node.y ?? 0;

      ctx.save();
      ctx.globalAlpha = dim ? 0.18 : 1;
      ctx.fillStyle = color;
      traceNode(ctx, node.kind, nx, ny, radius);
      ctx.fill();

      if (isSelected) {
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = "rgba(255,255,255,0.92)";
        traceNode(ctx, node.kind, nx, ny, radius);
        ctx.stroke();
      }

      const zoomAlpha = Math.max(0, Math.min(1, (globalScale - LABEL_THRESHOLD) / 0.35));
      if (isFocused || isSelected || zoomAlpha > 0.01) {
        const fontSize = Math.max(10 / globalScale, 11.5 / globalScale);
        const label = node.label.length > 38 ? `${node.label.slice(0, 35)}...` : node.label;
        ctx.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.globalAlpha = isFocused || isSelected ? 1 : zoomAlpha * (dim ? 0.18 : 1);
        ctx.fillStyle = "#e2e8f0";
        ctx.fillText(label, nx, ny + radius + 4 / globalScale);
      }
      ctx.restore();
    },
    [selected],
  );

  const linkColor = useCallback((link: Link) => {
    const hover = hoverRef.current;
    const base = LINK_BY_RELATION[link.relation] ?? LINK_BASE;
    if (hover.id === null) return base;
    const touches = endpointId(link.source) === hover.id || endpointId(link.target) === hover.id;
    return touches ? base : "rgba(148, 163, 184, 0.08)";
  }, []);

  const applyZoom = useCallback((factor: number) => {
    const current = Number(fgRef.current?.zoom?.() ?? 1);
    fgRef.current?.zoom?.(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current * factor)), 200);
  }, []);

  if (data.nodes.length === 0) {
    return (
      <div className="emptyState">
        <p>No memories yet.</p>
        <p>
          Save one from the Console tab, ingest a file with <code>memloom context add</code>, or ask
          your agent to — then run <code>index</code> to extract entities and watch the graph grow.
        </p>
      </div>
    );
  }

  return (
    <>
      <div ref={wrapRef} className="graphWrap">
        <ForceGraph2D
          ref={fgRef}
          width={size.width}
          height={size.height}
          graphData={data}
          backgroundColor="transparent"
          nodeCanvasObject={nodeCanvasObject}
          nodePointerAreaPaint={(node: Node, color, ctx) => {
            const half = Math.max(node.size * 1.6, 9);
            ctx.fillStyle = color;
            ctx.fillRect((node.x ?? 0) - half, (node.y ?? 0) - half, half * 2, half * 2);
          }}
          linkColor={linkColor}
          linkWidth={(l: Link) => (l.weight ? Math.min(1 + Math.log2(l.weight + 1), 3.5) : 1)}
          nodeRelSize={6}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          onNodeHover={handleHover}
          onNodeClick={handleClick}
          onBackgroundClick={() => setSelected(null)}
          autoPauseRedraw={false}
        />
        <div className="zoomRail">
          <button
            type="button"
            className="zoomButton"
            onClick={() => applyZoom(ZOOM_STEP)}
            title="Zoom in"
          >
            +
          </button>
          <button
            type="button"
            className="zoomButton"
            onClick={() => applyZoom(1 / ZOOM_STEP)}
            title="Zoom out"
          >
            −
          </button>
          <button
            type="button"
            className="zoomButton"
            onClick={() => fgRef.current?.zoomToFit?.(600, 90)}
            title="Fit view"
          >
            ⊡
          </button>
        </div>
        <div className="legend">
          <div className="legendRow">
            <span className="swatchSquare" style={{ background: MEMORY_COLOR }} />
            memory
          </div>
          <div className="legendRow">
            <span className="swatchCircle" style={{ background: ENTITY_COLOR }} />
            entity
          </div>
          <div className="legendRow">
            <span className="swatchDiamond" style={{ background: DOCUMENT_COLOR }} />
            document
          </div>
          <div className="legendRow">
            <span className="swatchSquare swatchSmall" style={{ background: CHUNK_COLOR }} />
            chunk
          </div>
        </div>
      </div>
      {selected && (
        <aside className="sidePanel">
          <div className="sidePanelKind" style={{ color: NODE_COLOR[selected.kind] }}>
            {selected.kind}
          </div>
          <h2 className="sidePanelTitle">{selected.title}</h2>
          <div className="sidePanelBody">{selected.body}</div>
          <div className="sidePanelMeta">id {selected.id}</div>
          {selected.kind === "document" && (
            <div className="sidePanelMeta">click the node to toggle its chunks</div>
          )}
        </aside>
      )}
    </>
  );
}
