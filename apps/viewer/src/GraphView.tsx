import { forceCollide } from "d3-force-3d";
import {
  Box,
  FilePlus,
  Maximize,
  MessageSquare,
  Minus,
  Plus,
  Route,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import ForceGraph3D from "react-force-graph-3d";
import type * as THREE from "three";
import { AssistantView } from "./AssistantView";
import { api, type ContextChunk, type DocumentChunks, type Graph } from "./api";
import { AddFileCard, AddLinkCard } from "./cards";
import { GraphControlsPanel } from "./GraphControlsPanel";
import {
  flyToNode,
  makeLinkSprite,
  makeNodeObject,
  type NodeObject3D,
  nodeTooltipHtml,
  styleNodeObjects,
  zoomCamera,
} from "./graph3d";
import {
  cloneGraphConfig,
  DEFAULT_GRAPH_CONFIG,
  type GraphNodeKind,
  type ViewerGraphConfig,
} from "./graphConfig";
import {
  buildGraphData,
  type CachedNodePosition,
  type GraphRegistry,
  getAnchorStrength,
  isPredicateLink,
  type Link,
  type Node,
  PALETTES,
  type Palette,
  relationColor,
} from "./graphData";
import {
  clamp01,
  getLinkEndpointId,
  mixColors,
  pickLabelAnchor,
  rectContainsPoint,
  scaleColorAlpha,
  segmentBBoxIntersectsRect,
  type ViewRect,
} from "./graphRender";
import type { ScopeSelection } from "./ScopeTree";
import { TraverseView } from "./TraverseView";
import { useTheme } from "./useTheme";

// The memory graph on a production-proven canvas architecture: home-anchor physics
// (every node has a deterministic home a custom force pulls it toward; nothing is pinned,
// nothing drifts), a full force stack (link/charge/collision + anchor) driven by a live
// controls panel, animated hover focus, and neighbor-aware label placement. memloom's
// pixel-motif stays: memories are squares, entities circles, documents diamonds; clicking
// a document blooms its chunks around it. The 3D toggle re-renders the same build as a
// three.js scene (cubes, spheres, octahedra) with orbit-style inspection.

const LABEL_BASE_THRESHOLD = 0.55;
const MIN_ZOOM = 0.14;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.4;
const INITIAL_MAX_ZOOM = 1.35;
const BASE_LINK_WIDTH = 1;
// Above this the per-node SpriteText labels (one canvas texture each) cost more than
// they say; the hover tooltip still names everything.
const MAX_3D_LABELED_NODES = 1500;

type GraphMode = "2d" | "3d";

type Selected = { kind: GraphNodeKind; title: string; body: string; id: string } | null;

// Positions survive data rebuilds (expand/collapse, 15s refetch) so the layout never
// re-randomizes under the user. One cache per renderer: the 2D layout is a plane, the
// 3D one a cloud, and seeding either from the other would flatten or shear it.
const POSITION_CACHE_2D = new Map<string, CachedNodePosition>();
const POSITION_CACHE_3D = new Map<string, CachedNodePosition>();

// Instance reuse across rebuilds (see GraphRegistry): both renderers join data by object
// identity, so same instances = incremental scene updates instead of full teardowns.
const GRAPH_REGISTRY_2D: GraphRegistry = { nodes: new Map(), links: new Map() };
const GRAPH_REGISTRY_3D: GraphRegistry = { nodes: new Map(), links: new Map() };

// One path per node kind: square (memory, chunk: content is square), circle (entity),
// diamond (document).
function traceNode(
  ctx: CanvasRenderingContext2D,
  kind: GraphNodeKind,
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

type HoverState = {
  focusNode: string | null;
  neighborSet: Set<string>;
  mix: number;
  target: number;
  rafId: number | null;
};

export function GraphView({
  graph,
  active,
  focus,
  onFocusConsumed,
  onChanged,
}: {
  graph: Graph;
  /** False while another tab is shown: the view stays mounted but its animation pauses. */
  active: boolean;
  /** A node id to select and center on when the tab opens (e.g. from an assistant source). */
  focus?: string | null;
  onFocusConsumed?: () => void;
  /** Called after a file is ingested from the docked "+ add" panel, so App refetches. */
  onChanged?: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // react-force-graph's methods surface (zoom, zoomToFit, d3Force, ...). Kept loose.
  // biome-ignore lint/suspicious/noExplicitAny: untyped imperative handle from the lib
  const fgRef = useRef<any>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [selected, setSelected] = useState<Selected>(null);
  const [panelWidth, setPanelWidth] = useState(320);
  const [expanded, setExpanded] = useState<Map<string, DocumentChunks>>(new Map());
  // The right-hand dock: launched from the corner buttons above the legend. One panel hosts
  // either the compact assistant or the "+ add" file ingest, at a width the user can drag.
  const [dock, setDock] = useState<"assistant" | "add" | "traverse" | null>(null);

  // The set of node ids a traverse result covers, or null when nothing is being traversed.
  // Kept in a ref because the canvas callbacks read it every frame and must not be rebuilt
  // per render; the state copy exists only to drive the redraw when the answer changes.
  const traverseRef = useRef<Set<string> | null>(null);
  const [traverseFocus, setTraverseFocus] = useState<Set<string> | null>(null);
  const [dockWidth, setDockWidth] = useState(420);

  // Drag the panel's left edge to resize; clamped so it can neither vanish nor eat the canvas.
  const startPanelResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = panelWidth;
      const onMove = (ev: PointerEvent) => {
        setPanelWidth(Math.min(640, Math.max(240, startWidth + (startX - ev.clientX))));
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [panelWidth],
  );

  const startDockResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = dockWidth;
      const onMove = (ev: PointerEvent) => {
        setDockWidth(Math.min(760, Math.max(320, startWidth + (startX - ev.clientX))));
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [dockWidth],
  );
  const [config, setConfig] = useState<ViewerGraphConfig>(() =>
    cloneGraphConfig(DEFAULT_GRAPH_CONFIG),
  );
  // The folder filter from the controls panel. Held here, not in the panel, so closing
  // the panel does not silently unfilter the canvas.
  const [scopeSel, setScopeSel] = useState<ScopeSelection | null>(null);
  const [showControls, setShowControls] = useState(false);
  // 2D canvas or 3D scene. Both simulate with d3-force-3d, so the force stack and the
  // controls panel drive either; only the renderer and its camera differ.
  const [mode, setMode] = useState<GraphMode>("2d");
  const is3D = mode === "3d";
  const modeRef = useRef(mode);
  useEffect(() => {
    modeRef.current = mode;
  });
  const [remountKey, setRemountKey] = useState(0);
  const previousNodeCountRef = useRef(0);
  const hasUserInteractedRef = useRef(false);

  const theme = useTheme();
  const pal = PALETTES[theme];
  const palRef = useRef<Palette>(pal);
  useEffect(() => {
    palRef.current = PALETTES[theme];
  }, [theme]);

  // The brand color (hover highlight target) follows the theme via the CSS token.
  const brandRef = useRef("#f59e0b");
  useEffect(() => {
    const read = () => {
      const value = getComputedStyle(document.documentElement).getPropertyValue("--brand").trim();
      if (value) brandRef.current = value;
    };
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  const hoverRef = useRef<HoverState>({
    focusNode: null,
    neighborSet: new Set(),
    mix: 0,
    target: 0,
    rafId: null,
  });

  // The selected node feeds the build: with "show entities" off it decides which
  // entities are revealed. Selecting/deselecting rebuilds; positions survive via the cache.
  const selectedId = selected?.id ?? null;
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  });
  // Selection and traverse only shape the build while entities are hidden (they gate the
  // reveal set); with entities shown, feeding them in would rebuild the whole graph on
  // every click for an identical result. Null them out so the memo holds.
  const revealSelectedId = config.display.showEntities ? null : selectedId;
  const revealTraverse = config.display.showEntities ? null : traverseFocus;
  const { graphData, nodeMap, neighborMap, chunkParent } = useMemo(
    () =>
      buildGraphData(
        graph,
        expanded,
        config,
        revealSelectedId,
        revealTraverse,
        scopeSel,
        is3D ? POSITION_CACHE_3D : POSITION_CACHE_2D,
        is3D ? GRAPH_REGISTRY_3D : GRAPH_REGISTRY_2D,
        is3D,
      ),
    [graph, expanded, config, revealSelectedId, revealTraverse, scopeSel, is3D],
  );

  const nodeMapRef = useRef(nodeMap);
  useEffect(() => {
    nodeMapRef.current = nodeMap;
  });

  // Select a node and pan to it. Shared by the external focus prop below and the traverse
  // panel, which is the same gesture from two directions: something outside the canvas names
  // a node and the canvas has to go show it. Reads the live node map through the ref rather
  // than closing over it, so this identity survives every graph rebuild.
  const focusNode = useCallback(
    (id: string) => {
      const node = nodeMapRef.current.get(id);
      if (node) {
        setSelected({ kind: node.kind, title: node.label, body: node.full, id: node.id });
      } else {
        // A hidden entity ("show entities" off) has no node yet; selecting it is what
        // reveals it, so build the selection straight from the graph payload.
        const entity = graph.entities.find((e) => e.id === id);
        if (entity) {
          setSelected({
            kind: "entity",
            title: entity.name,
            body: `${entity.name} (${entity.entityType})`,
            id: entity.id,
          });
        }
      }
      window.setTimeout(() => {
        // Re-resolve: the reveal rebuild may have created the node after this ran.
        const target = nodeMapRef.current.get(id);
        if (target?.x == null || target.y == null) return;
        if (modeRef.current === "3d") {
          flyToNode(fgRef.current, target);
        } else {
          fgRef.current?.centerAt?.(target.x, target.y, 600);
        }
      }, 320);
    },
    [graph.entities],
  );

  /**
   * Light up a traverse answer on the canvas: the entity asked about, the entities it is
   * connected to, and the memories and documents the focal entity is attached to. Those
   * sources are included because they are the evidence behind the answer; the neighbours'
   * own sources are not, or a hub entity would light up most of the graph and dim nothing.
   */
  const showTraverse = useCallback(
    (focal: string | null, related: string[]) => {
      if (!focal) {
        setTraverseFocus(null);
        return;
      }
      const set = new Set<string>([focal, ...related]);
      // Read the raw payload rather than the built neighbourMap: with "show entities" off the
      // built graph may not contain these nodes yet, and this set is what makes them appear.
      for (const e of graph.edges) {
        if (e.from === focal) set.add(e.to);
        if (e.to === focal) set.add(e.from);
      }
      setTraverseFocus(set);
    },
    [graph.edges],
  );

  // Push the set into the ref the canvas callbacks read, then force one redraw: the
  // simulation may already be settled, in which case nothing else would repaint.
  useEffect(() => {
    traverseRef.current = traverseFocus;
    fgRef.current?.refresh?.();
  }, [traverseFocus]);

  // Closing the panel (or switching it to another tool) must clear the highlight, or the
  // graph stays half-dark with no visible reason why.
  useEffect(() => {
    if (dock !== "traverse") setTraverseFocus(null);
  }, [dock]);

  // External focus: an assistant source asks to see itself in the graph. The target arrives
  // as a prop from App (which also switches the tab, so the view is visible and resumed when
  // the recenter fires). Consume the request afterwards so App's background refresh does not
  // re-center every tick.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot on the focus prop only
  useEffect(() => {
    if (!focus) return;
    focusNode(focus);
    onFocusConsumed?.();
  }, [focus]);

  // Persist positions so a rebuild (refetch, expand/collapse) never relayouts from scratch.
  useEffect(() => {
    const cache = modeRef.current === "3d" ? POSITION_CACHE_3D : POSITION_CACHE_2D;
    cache.clear();
    nodeMap.forEach((node, id) => {
      cache.set(id, {
        x: node.x,
        y: node.y,
        z: node.z,
        vx: node.vx,
        vy: node.vy,
        vz: node.vz,
        homeX: node.homeX,
        homeY: node.homeY,
        homeZ: node.homeZ,
      });
    });
  }, [nodeMap]);

  // Remount when nodes are removed (collapse, doc deletion) so orphaned dots don't
  // linger. 2D only: the 3D data join removes and disposes stale objects itself, and a
  // remount there throws away the whole WebGL scene.
  useEffect(() => {
    const count = graphData.nodes.length;
    if (count < previousNodeCountRef.current && modeRef.current === "2d") {
      setRemountKey((k) => k + 1);
    }
    previousNodeCountRef.current = count;
  }, [graphData.nodes.length]);

  useEffect(() => {
    if (!wrapRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      // A hidden tab (display:none) reports 0x0; keep the last real size so the library
      // never sees a size change while hidden (it pans the view on every resize).
      if (!rect || rect.width === 0 || rect.height === 0) return;
      setSize((prev) => {
        const width = Math.max(320, rect.width);
        const height = Math.max(320, rect.height);
        return prev.width === width && prev.height === height ? prev : { width, height };
      });
    });
    observer.observe(wrapRef.current);
    return () => observer.disconnect();
  }, []);

  // True once the current renderer instance's force engine has ticked, meaning its layout
  // exists and d3ReheatSimulation is safe to call. False again on every (re)mount.
  const engineReadyRef = useRef(false);

  // The full force stack: per-relation link tuning, bounded charge, collision, and the
  // home-anchor force that replaces both pinning and d3's center force: every node is
  // gently pulled toward its own home, so the layout breathes without drifting.
  const configureForcesRef = useRef<() => void>(() => {});
  const configureForces = useCallback(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const f = config.forces;

    fg.d3Force?.("center", null);
    fg.d3Force?.("link")
      ?.distance((l: Link) => f.linkDistance * f.linkDistanceMultiplier[l.relation])
      .strength((l: Link) => f.linkForce * f.linkStrengthMultiplier[l.relation]);

    const charge = fg.d3Force?.("charge");
    charge?.strength((n: Node) => -f.repelForce * f.nodeRepulsionMultiplier[n.kind]);
    charge?.distanceMax?.(f.chargeDistanceMax);
    charge?.theta?.(f.chargeTheta);

    fg.d3Force?.(
      "collide",
      forceCollide<Node>()
        .radius((n: Node) => n.size * f.collisionRadiusMultiplier[n.kind])
        .strength(0.95)
        .iterations(2),
    );

    fg.d3Force?.("anchor", (alpha: number) => {
      const strength = getAnchorStrength(f.centerForce);
      nodeMapRef.current.forEach((node) => {
        // Chunks anchor lightly. Their short stiff tethers to the document do the work.
        const s = node.kind === "chunk" ? strength * 0.5 : strength;
        node.vx = (node.vx ?? 0) + ((node.homeX ?? 0) - (node.x ?? 0)) * s * alpha;
        node.vy = (node.vy ?? 0) + ((node.homeY ?? 0) - (node.y ?? 0)) * s * alpha;
        // Only the 3D build sets homeZ; in 2D the z fields stay untouched.
        if (node.homeZ !== undefined) {
          node.vz = (node.vz ?? 0) + (node.homeZ - (node.z ?? 0)) * s * alpha;
        }
      });
    });

    fg.d3VelocityDecay?.(f.velocityDecay);
    fg.d3AlphaDecay?.(f.alphaDecay);
    fg.d3AlphaMin?.(f.alphaMin);
    // Reheating before the first tick crashes the 3D renderer: its tick loop assumes the
    // layout the (async) data digest creates, and the digest starts the engine itself. On
    // a fresh instance the force parameters above are all that is needed.
    if (engineReadyRef.current) fg.d3ReheatSimulation?.();
  }, [config]);

  useEffect(() => {
    configureForcesRef.current = configureForces;
  }, [configureForces]);

  useEffect(() => {
    configureForces();
  }, [configureForces]);
  // Re-apply after (re)mount: the graph instance is fresh and has default forces. A mode
  // switch is a remount too (the other renderer takes over the same ref).
  // biome-ignore lint/correctness/useExhaustiveDependencies: remountKey and mode ARE the trigger
  useEffect(() => {
    engineReadyRef.current = false;
    const raf = requestAnimationFrame(() => configureForcesRef.current());
    return () => cancelAnimationFrame(raf);
  }, [remountKey, mode]);

  // Initial framing: fit, then clamp the zoom so a tiny graph doesn't fill the screen.
  // Re-runs on a mode switch, because the fresh renderer starts at its default camera.
  useEffect(() => {
    const fitId = window.setTimeout(() => fgRef.current?.zoomToFit?.(700, 110), 180);
    const clampId = window.setTimeout(() => {
      // The 3D camera has no zoom scalar to clamp; zoomToFit already frames it sanely.
      if (mode === "3d" || hasUserInteractedRef.current) return;
      const current = Number(fgRef.current?.zoom?.() ?? 1);
      if (current > INITIAL_MAX_ZOOM) fgRef.current?.zoom?.(INITIAL_MAX_ZOOM, 220);
    }, 980);
    return () => {
      window.clearTimeout(fitId);
      window.clearTimeout(clampId);
    };
  }, [mode]);

  // Hover focus fades in/out instead of snapping (a mix-fade animation).
  const ensureHoverAnimation = useCallback(() => {
    if (hoverRef.current.rafId !== null) return;
    const tick = () => {
      const hover = hoverRef.current;
      hover.mix += (hover.target - hover.mix) * 0.28;
      if (Math.abs(hover.target - hover.mix) < 0.01) {
        hover.mix = hover.target;
        hover.rafId = null;
        return;
      }
      hover.rafId = requestAnimationFrame(tick);
    };
    hoverRef.current.rafId = requestAnimationFrame(tick);
  }, []);

  useEffect(() => {
    const hover = hoverRef.current;
    return () => {
      if (hover.rafId !== null) cancelAnimationFrame(hover.rafId);
    };
  }, []);

  const handleHover = useCallback(
    (node: Node | null) => {
      const hover = hoverRef.current;
      if (node) {
        hover.focusNode = node.id;
        hover.neighborSet = neighborMap.get(node.id) ?? new Set();
        hover.target = 1;
      } else {
        hover.focusNode = null;
        hover.neighborSet = new Set();
        hover.target = 0;
      }
      ensureHoverAnimation();
      if (wrapRef.current) wrapRef.current.style.cursor = node ? "pointer" : "default";
    },
    [neighborMap, ensureHoverAnimation],
  );

  // Hidden tab: stop the render loop entirely (canvas, hover picking, tweens). Clearing
  // hover first lets the fade loop terminate so no stale highlight waits on return.
  // biome-ignore lint/correctness/useExhaustiveDependencies: remountKey and mode are deliberate; a fresh inner instance auto-starts its loop and must be re-paused while hidden
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    if (active) {
      fg.resumeAnimation?.();
    } else {
      handleHover(null);
      fg.pauseAnimation?.();
    }
  }, [active, remountKey, mode, handleHover]);

  const handleClick = useCallback(
    (node: Node) => {
      hasUserInteractedRef.current = true;
      setSelected({ kind: node.kind, title: node.label, body: node.full, id: node.id });
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
        .catch(() => {}); // daemon hiccup: stay collapsed, next click retries
    },
    [expanded],
  );

  // Dragging a node re-homes it: the anchor force now holds it where the user put it.
  const handleNodeDragEnd = useCallback((node: Node) => {
    const is3DDrag = modeRef.current === "3d";
    node.homeX = node.x;
    node.homeY = node.y;
    if (is3DDrag) node.homeZ = node.z;
    (is3DDrag ? POSITION_CACHE_3D : POSITION_CACHE_2D).set(node.id, {
      x: node.x,
      y: node.y,
      z: node.z,
      vx: node.vx,
      vy: node.vy,
      vz: node.vz,
      homeX: node.homeX,
      homeY: node.homeY,
      homeZ: node.homeZ,
    });
    fgRef.current?.d3ReheatSimulation?.();
  }, []);

  // Select a chunk from the side panel's list and pan the canvas to it.
  const selectChunk = useCallback(
    (chunk: ContextChunk) => {
      setSelected({
        kind: "chunk",
        title: chunk.headingPath ?? `#${chunk.chunkIndex + 1}`,
        body: chunk.content,
        id: chunk.id,
      });
      const node = nodeMap.get(chunk.id);
      if (node?.x == null || node.y == null) return;
      if (modeRef.current === "3d") flyToNode(fgRef.current, node, 500);
      else fgRef.current?.centerAt?.(node.x, node.y, 400);
    },
    [nodeMap],
  );

  // Viewport culling: the visible world rect is computed once per frame (before paint) and
  // read by the stable visibility accessors below, so off-screen nodes, links, labels,
  // arrowheads, and pointer-pick painting are all skipped. At 3,800 nodes this is the
  // difference between a smooth deep zoom and a frozen one.
  const cullRectRef = useRef<ViewRect | null>(null);
  // True while the d3 engine is ticking (layout moving): label anchors recompute then.
  const simActiveRef = useRef(true);

  const handleRenderFramePre = useCallback(
    (_ctx: CanvasRenderingContext2D, globalScale: number) => {
      const fg = fgRef.current;
      if (!fg?.screen2GraphCoords) {
        cullRectRef.current = null;
        return;
      }
      const tl = fg.screen2GraphCoords(0, 0);
      const br = fg.screen2GraphCoords(size.width, size.height);
      // Pad by the node glyph overhang, plus label text overhang (screen px -> world units)
      // whenever zoom is inside the label band, so labels never pop at the edges.
      const labelThreshold = LABEL_BASE_THRESHOLD * config.display.labelFadeThreshold;
      const labelsPossible = globalScale > labelThreshold * 0.7;
      const pad = 40 + (labelsPossible ? 320 / globalScale : 0);
      cullRectRef.current = {
        left: tl.x - pad,
        top: tl.y - pad,
        right: br.x + pad,
        bottom: br.y + pad,
      };
    },
    [size, config.display.labelFadeThreshold],
  );

  const nodeVisibility = useCallback((node: Node) => {
    const rect = cullRectRef.current;
    return !rect || rectContainsPoint(rect, node.x ?? 0, node.y ?? 0);
  }, []);

  const linkVisibility = useCallback((link: Link) => {
    const rect = cullRectRef.current;
    if (!rect) return true;
    const s = link.source;
    const t = link.target;
    if (typeof s === "string" || typeof t === "string") return true; // pre-init tick
    return segmentBBoxIntersectsRect(rect, s.x ?? 0, s.y ?? 0, t.x ?? 0, t.y ?? 0);
  }, []);

  const nodeCanvasObject = useCallback(
    (node: Node, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const p = palRef.current;
      const hover = hoverRef.current;
      const isSelected = selected?.id === node.id;
      const isFocused = hover.focusNode === node.id;
      const isNeighbor = hover.neighborSet.has(node.id);
      // A traverse result mutes everything outside the neighbourhood being examined. Harder
      // than the hover fade and it wins over it: hover is a glance, traverse is a question the
      // user asked, so the answer should stay legible while they move the cursor around.
      const outside = traverseRef.current != null && !traverseRef.current.has(node.id);
      const alpha = outside
        ? 0.06
        : !hover.focusNode
          ? 1
          : isFocused || isNeighbor || isSelected
            ? 1
            : Math.max(0.14, 1 - hover.mix * 0.84);
      const radius =
        node.size *
        (isSelected
          ? 1.22
          : isFocused
            ? 1 + 0.16 * hover.mix
            : isNeighbor
              ? 1 + 0.05 * hover.mix
              : 1);
      const baseColor = p[node.kind];
      const fillColor = isFocused ? mixColors(baseColor, brandRef.current, hover.mix) : baseColor;
      const nx = node.x ?? 0;
      const ny = node.y ?? 0;

      ctx.save();
      ctx.fillStyle = scaleColorAlpha(fillColor, alpha);
      traceNode(ctx, node.kind, nx, ny, radius);
      ctx.fill();

      if (isSelected) {
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = scaleColorAlpha(p.selectedStroke, alpha);
        traceNode(ctx, node.kind, nx, ny, radius);
        ctx.stroke();
      }

      const labelThreshold = LABEL_BASE_THRESHOLD * config.display.labelFadeThreshold;
      const fadeRange = labelThreshold * 0.3;
      const labelZoomAlpha = clamp01((globalScale - (labelThreshold - fadeRange)) / fadeRange);
      if (isFocused || isSelected || labelZoomAlpha > 0.01) {
        // The anchor iterates the node's neighbors; while the layout is settled that work
        // is identical every frame, so it is cached on the node (fresh Node objects on
        // every rebuild make staleness impossible).
        let anchor = node.labelAnchor;
        if (anchor === undefined || simActiveRef.current) {
          anchor = pickLabelAnchor(node, neighborMap, nodeMap);
          node.labelAnchor = anchor;
        }
        const fontSize = Math.max(
          10 / globalScale,
          isSelected || isFocused ? 13.2 / globalScale : 11.5 / globalScale,
        );
        const label = node.label.length > 38 ? `${node.label.slice(0, 35)}...` : node.label;
        ctx.font = `${isSelected ? 700 : 600} ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;

        let textX = nx;
        let textY = ny;
        ctx.textAlign = anchor === "left" ? "right" : anchor === "right" ? "left" : "center";
        ctx.textBaseline = anchor === "top" ? "bottom" : anchor === "bottom" ? "top" : "middle";
        if (anchor === "right") textX += radius + 9 / globalScale;
        else if (anchor === "left") textX -= radius + 9 / globalScale;
        else if (anchor === "top") textY -= radius + 9 / globalScale;
        else textY += radius + 9 / globalScale;

        const labelAlpha = isFocused || isSelected ? alpha : alpha * labelZoomAlpha;
        ctx.fillStyle = scaleColorAlpha(p.label, labelAlpha);
        ctx.fillText(label, textX, textY);
      }
      ctx.restore();
    },
    [selected, neighborMap, nodeMap, config.display.labelFadeThreshold],
  );

  const linkColor = useCallback((link: Link) => {
    const hover = hoverRef.current;
    const base = relationColor(palRef.current, link.relation);
    const s = getLinkEndpointId(link.source);
    const t = getLinkEndpointId(link.target);
    // An edge belongs to the traverse result only when BOTH ends do; a link running out of
    // the neighbourhood is exactly the noise the dimming exists to remove.
    const tf = traverseRef.current;
    if (tf && !(tf.has(s) && tf.has(t))) return scaleColorAlpha(base, 0.05);
    const touches = hover.focusNode === s || hover.focusNode === t;
    if (touches) return mixColors(base, brandRef.current, hover.mix);
    if (!hover.focusNode) return base;
    return scaleColorAlpha(base, Math.max(0.5, 1 - hover.mix * 0.55));
  }, []);

  // Edge labels: the relation name drawn along the link, above the line, never upside
  // down. Fades in with zoom like node labels; dims with the hover focus like the link.
  const edgeLabelMode = config.display.edgeLabels;
  const linkCanvasObject = useCallback(
    (link: Link, ctx: CanvasRenderingContext2D, globalScale: number) => {
      if (edgeLabelMode === "off") return;
      if (edgeLabelMode === "predicates" && !isPredicateLink(link)) return;
      const s = link.source;
      const t = link.target;
      if (typeof s === "string" || typeof t === "string") return; // pre-init tick

      const labelThreshold = LABEL_BASE_THRESHOLD * config.display.labelFadeThreshold;
      const fadeRange = labelThreshold * 0.3;
      const zoomAlpha = clamp01((globalScale - (labelThreshold - fadeRange)) / fadeRange);
      if (zoomAlpha <= 0.01) return;

      const hover = hoverRef.current;
      const touches = hover.focusNode === s.id || hover.focusNode === t.id;
      const hoverAlpha = !hover.focusNode || touches ? 1 : Math.max(0.12, 1 - hover.mix * 0.86);

      const sx = s.x ?? 0;
      const sy = s.y ?? 0;
      const tx = t.x ?? 0;
      const ty = t.y ?? 0;
      let angle = Math.atan2(ty - sy, tx - sx);
      // Keep text readable: flip when the link points leftward.
      if (angle > Math.PI / 2) angle -= Math.PI;
      else if (angle < -Math.PI / 2) angle += Math.PI;

      ctx.save();
      ctx.translate((sx + tx) / 2, (sy + ty) / 2);
      ctx.rotate(angle);
      const fontSize = 9.5 / globalScale;
      ctx.font = `500 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillStyle = scaleColorAlpha(palRef.current.label, 0.85 * zoomAlpha * hoverAlpha);
      ctx.fillText(link.label, 0, -2.5 / globalScale);
      ctx.restore();
    },
    [edgeLabelMode, config.display.labelFadeThreshold],
  );

  // Rolled-up document -> entity edges thicken with how many chunks mention the entity.
  const linkWidth = useCallback(
    (link: Link) => {
      const weightScale = link.weight > 1 ? 0.9 + Math.min(link.weight - 1, 4) * 0.45 : 1;
      return BASE_LINK_WIDTH * config.display.linkThicknessMultiplier * weightScale;
    },
    [config.display.linkThicknessMultiplier],
  );

  const applyZoom = useCallback((factor: number) => {
    hasUserInteractedRef.current = true;
    if (modeRef.current === "3d") {
      zoomCamera(fgRef.current, factor);
      return;
    }
    const current = Number(fgRef.current?.zoom?.() ?? 1);
    fgRef.current?.zoom?.(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current * factor)), 220);
  }, []);

  // 3D mode
  // Every node's three.js object, registered as the accessor builds it. Hover, selection,
  // and traverse styling mutate these materials in place: no React render, no scene
  // rebuild. Rebuilds overwrite entries by id; the map is dropped with the 3D renderer.
  const threeObjectsRef = useRef(new Map<string, NodeObject3D>());
  useEffect(() => {
    if (!is3D) threeObjectsRef.current.clear();
  }, [is3D]);

  const style3D = useCallback(() => {
    styleNodeObjects(threeObjectsRef.current, {
      hoverId: hoverRef.current.focusNode,
      neighbors: hoverRef.current.neighborSet,
      selectedId: selectedIdRef.current,
      traverse: traverseRef.current,
      brand: brandRef.current,
    });
  }, []);

  // Selection, traverse, and data rebuilds change what the materials should show. The
  // timeout lands after the renderer has digested the new data and built the objects.
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedId/traverseFocus/graphData are the triggers; style3D reads their live values through refs
  useEffect(() => {
    if (!is3D) return;
    const t = window.setTimeout(() => {
      // Drop registrations for nodes the data join removed (the lib disposed their
      // materials); styling a dead entry would resurrect nothing but leak the reference.
      const objects = threeObjectsRef.current;
      for (const id of objects.keys()) {
        if (!nodeMapRef.current.has(id)) objects.delete(id);
      }
      style3D();
    }, 60);
    return () => window.clearTimeout(t);
  }, [is3D, selectedId, traverseFocus, graphData, style3D]);

  const handleHover3D = useCallback(
    (node: Node | null) => {
      handleHover(node);
      style3D();
    },
    [handleHover, style3D],
  );

  // Same select/expand semantics as 2D, plus the camera flight to the clicked node.
  const handleClick3D = useCallback(
    (node: Node) => {
      handleClick(node);
      flyToNode(fgRef.current, node);
    },
    [handleClick],
  );

  const labeled3D = graphData.nodes.length <= MAX_3D_LABELED_NODES;
  const nodeThreeObject = useCallback(
    (node: Node) => {
      const obj = makeNodeObject(node, pal, labeled3D);
      threeObjectsRef.current.set(node.id, obj);
      return obj.group;
    },
    [pal, labeled3D],
  );

  // No hover mixing here (materials are mutated directly instead); the accessor is
  // re-evaluated on refresh(), which the traverse effect triggers.
  const linkColor3D = useCallback((link: Link) => {
    const base = relationColor(palRef.current, link.relation);
    const tf = traverseRef.current;
    if (tf) {
      const s = getLinkEndpointId(link.source);
      const t = getLinkEndpointId(link.target);
      if (!(tf.has(s) && tf.has(t))) return scaleColorAlpha(base, 0.06);
    }
    return base;
  }, []);

  const linkThreeObject3D = useCallback(
    (link: Link) => {
      if (edgeLabelMode === "off") return undefined;
      if (edgeLabelMode === "predicates" && !isPredicateLink(link)) return undefined;
      return makeLinkSprite(link.label, pal);
    },
    [edgeLabelMode, pal],
  );

  // Keeps each relation-name sprite at its link's midpoint as the simulation moves.
  const linkSpritePosition = useCallback(
    (
      sprite: { position: { set: (x: number, y: number, z: number) => void } } | null,
      coords: {
        start: { x: number; y: number; z?: number };
        end: { x: number; y: number; z?: number };
      },
    ) => {
      if (!sprite) return false;
      const { start, end } = coords;
      sprite.position.set(
        (start.x + end.x) / 2,
        (start.y + end.y) / 2,
        ((start.z ?? 0) + (end.z ?? 0)) / 2,
      );
      return true;
    },
    [],
  );

  if (graphData.nodes.length === 0) {
    return (
      <div className="emptyState">
        <p>No memories yet.</p>
        <p>
          Save one from the Console tab, ingest a file with <code>memloom context add</code>, or ask
          your agent to, then run <code>index</code> to extract entities and watch the graph grow.
        </p>
      </div>
    );
  }

  return (
    <>
      <div ref={wrapRef} className="graphWrap">
        {is3D ? (
          <ForceGraph3D
            key={remountKey}
            ref={fgRef}
            width={size.width}
            height={size.height}
            graphData={graphData}
            backgroundColor="rgba(0,0,0,0)"
            cooldownTicks={config.forces.cooldownTicks}
            showNavInfo={false}
            onEngineTick={() => {
              engineReadyRef.current = true;
            }}
            nodeThreeObject={nodeThreeObject}
            nodeLabel={nodeTooltipHtml}
            linkColor={linkColor3D}
            linkWidth={0}
            linkOpacity={0.55}
            linkThreeObjectExtend={true}
            // The lib's type wants an Object3D for every link, but its runtime treats a
            // falsy return as "no extra object", which is what unlabeled links need.
            linkThreeObject={linkThreeObject3D as unknown as (link: Link) => THREE.Object3D}
            linkPositionUpdate={linkSpritePosition}
            // Predicates are directional facts; the particle drifts subject -> object.
            linkDirectionalParticles={(l: Link) => (isPredicateLink(l) ? 1 : 0)}
            linkDirectionalParticleWidth={1.8}
            linkDirectionalArrowLength={(l: Link) => (isPredicateLink(l) ? 3.5 : 0)}
            linkDirectionalArrowRelPos={0.85}
            enableNodeDrag
            onNodeHover={handleHover3D}
            onNodeClick={handleClick3D}
            onNodeDragEnd={handleNodeDragEnd}
            onBackgroundClick={() => setSelected(null)}
          />
        ) : (
          <ForceGraph2D
            key={remountKey}
            ref={fgRef}
            width={size.width}
            height={size.height}
            graphData={graphData}
            backgroundColor="transparent"
            cooldownTicks={config.forces.cooldownTicks}
            onRenderFramePre={handleRenderFramePre}
            nodeVisibility={nodeVisibility}
            linkVisibility={linkVisibility}
            onEngineTick={() => {
              simActiveRef.current = true;
              engineReadyRef.current = true;
            }}
            onEngineStop={() => {
              simActiveRef.current = false;
            }}
            nodeCanvasObject={nodeCanvasObject}
            nodePointerAreaPaint={(node: Node, color, ctx) => {
              const half = Math.max(node.size * 1.6, 9);
              ctx.fillStyle = color;
              ctx.fillRect((node.x ?? 0) - half, (node.y ?? 0) - half, half * 2, half * 2);
            }}
            linkColor={linkColor}
            linkWidth={linkWidth}
            linkCanvasObjectMode={() => "after"}
            linkCanvasObject={linkCanvasObject}
            // Predicates are directional facts (subject -> object). Labels without arrows
            // read half a claim. Structural edges stay arrowless.
            linkDirectionalArrowLength={(l: Link) =>
              edgeLabelMode !== "off" && isPredicateLink(l) ? 3.5 : 0
            }
            linkDirectionalArrowRelPos={0.82}
            nodeRelSize={6}
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            enableNodeDrag
            onNodeHover={handleHover}
            onNodeClick={handleClick}
            onNodeDragEnd={handleNodeDragEnd}
            onBackgroundClick={() => setSelected(null)}
            // Continuous redraw stays on: the hover fade and label zoom fade mutate refs
            // without marking the library's needsRedraw, so idle-pause would freeze them
            // mid-fade. With the pause-when-hidden effect and viewport culling, the cost is
            // zero while hidden and viewport-proportional while visible.
            autoPauseRedraw={false}
          />
        )}
        <div className="zoomRail">
          <button
            type="button"
            className="zoomButton"
            onClick={() => applyZoom(ZOOM_STEP)}
            title="Zoom in"
          >
            <Plus size={14} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className="zoomButton"
            onClick={() => applyZoom(1 / ZOOM_STEP)}
            title="Zoom out"
          >
            <Minus size={14} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className="zoomButton"
            onClick={() => {
              hasUserInteractedRef.current = true;
              fgRef.current?.zoomToFit?.(600, 110);
            }}
            title="Fit view"
          >
            <Maximize size={14} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className={`zoomButton ${is3D ? "zoomButtonActive" : ""}`}
            onClick={() => setMode((m) => (m === "2d" ? "3d" : "2d"))}
            title={is3D ? "Back to the flat graph" : "Inspect in 3D"}
          >
            <Box size={14} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className={`zoomButton ${showControls ? "zoomButtonActive" : ""}`}
            onClick={() => setShowControls((v) => !v)}
            title="Graph controls"
          >
            <SlidersHorizontal size={14} strokeWidth={1.75} />
          </button>
        </div>
        {showControls && (
          <GraphControlsPanel
            graphConfig={config}
            scopeSelected={scopeSel}
            onScopeSelect={setScopeSel}
            onChange={setConfig}
            onReset={() => setConfig(cloneGraphConfig(DEFAULT_GRAPH_CONFIG))}
            onClose={() => setShowControls(false)}
          />
        )}
        <div className="graphCorner">
          <button
            type="button"
            className={`graphLauncher ${dock === "traverse" ? "graphLauncherActive" : ""}`}
            onClick={() => setDock((d) => (d === "traverse" ? null : "traverse"))}
            title="Walk the graph from one entity"
          >
            <Route size={13} strokeWidth={1.75} /> traverse
          </button>
          <button
            type="button"
            className={`graphLauncher ${dock === "assistant" ? "graphLauncherActive" : ""}`}
            onClick={() => setDock((d) => (d === "assistant" ? null : "assistant"))}
            title="Ask the assistant"
          >
            <MessageSquare size={13} strokeWidth={1.75} /> assistant
          </button>
          <button
            type="button"
            className={`graphLauncher ${dock === "add" ? "graphLauncherActive" : ""}`}
            onClick={() => setDock((d) => (d === "add" ? null : "add"))}
            title="Add files to the knowledge base"
          >
            <FilePlus size={13} strokeWidth={1.75} /> add
          </button>
          <div className="legend">
            <div className="legendRow">
              <span className="swatchSquare" style={{ background: pal.memory }} />
              memory
            </div>
            <div className="legendRow">
              <span className="swatchCircle" style={{ background: pal.entity }} />
              entity
            </div>
            <div className="legendRow">
              <span className="swatchDiamond" style={{ background: pal.document }} />
              document
            </div>
            <div className="legendRow">
              <span className="swatchSquare swatchSmall" style={{ background: pal.chunk }} />
              chunk
            </div>
            {is3D && <div className="legendHint">drag rotates, scroll zooms, right-drag pans</div>}
          </div>
        </div>
      </div>
      {selected && (
        <aside className="sidePanel" style={{ width: panelWidth }}>
          <button
            type="button"
            className="sidePanelResize"
            aria-label="Resize details panel"
            onPointerDown={startPanelResize}
          />
          <button
            type="button"
            className="sidePanelClose"
            onClick={() => setSelected(null)}
            aria-label="Close details"
          >
            <X size={14} strokeWidth={1.75} />
          </button>
          {(() => {
            // Breadcrumb for chunks: "document › chunk", with the document clickable.
            if (selected.kind !== "chunk") return null;
            const parentId = chunkParent.get(selected.id);
            const parent = graph.documents.find((d) => d.id === parentId);
            if (!parent) return null;
            return (
              <div className="crumb">
                <button
                  type="button"
                  className="crumbLink"
                  onClick={() =>
                    setSelected({
                      kind: "document",
                      title: parent.title,
                      body: parent.path,
                      id: parent.id,
                    })
                  }
                >
                  {parent.title}
                </button>
                <span>›</span>
                <span className="crumbHere">{selected.title}</span>
              </div>
            );
          })()}
          <div className="sidePanelKind" style={{ color: pal[selected.kind] }}>
            {selected.kind}
          </div>
          <h2 className="sidePanelTitle">{selected.title}</h2>
          {/* Memories without a canonical title would repeat the title verbatim here. */}
          {selected.body !== selected.title && <div className="sidePanelBody">{selected.body}</div>}
          <div className="sidePanelMeta">id {selected.id}</div>
          {selected.kind === "document" &&
            (() => {
              const dc = expanded.get(selected.id);
              if (!dc) {
                return <div className="sidePanelMeta">click the node to toggle its chunks</div>;
              }
              return (
                <div className="sideChunkList">
                  <div className="cardLabel">chunks; {dc.chunks.length}</div>
                  {dc.chunks.map((c) => (
                    <button
                      type="button"
                      key={c.id}
                      className="sideChunkRow"
                      onClick={() => selectChunk(c)}
                    >
                      {c.headingPath ?? `#${c.chunkIndex + 1}`}
                      {c.page != null ? `; p. ${c.page}` : ""}
                    </button>
                  ))}
                </div>
              );
            })()}
        </aside>
      )}
      {dock && (
        <aside className="graphDock" style={{ width: dockWidth }}>
          <button
            type="button"
            className="sidePanelResize"
            aria-label="Resize panel"
            onPointerDown={startDockResize}
          />
          <div className="graphDockHead">
            <span className="graphDockTitle">
              {dock === "assistant"
                ? "assistant"
                : dock === "traverse"
                  ? "traverse the graph"
                  : "add to knowledge base"}
            </span>
            <button
              type="button"
              className="graphDockClose"
              onClick={() => setDock(null)}
              aria-label="Close panel"
            >
              <X size={14} strokeWidth={1.75} />
            </button>
          </div>
          <div className="graphDockBody">
            {dock === "assistant" ? (
              <AssistantView compact />
            ) : dock === "traverse" ? (
              <TraverseView onOpenEntity={focusNode} onResult={showTraverse} />
            ) : (
              <div className="graphDockScroll">
                <h2 className="sectionTitle">Add a file/folder</h2>
                <AddFileCard onAdded={() => onChanged?.()} />
                <h2 className="sectionTitle">Add a link</h2>
                <AddLinkCard onAdded={() => onChanged?.()} />
              </div>
            )}
          </div>
        </aside>
      )}
    </>
  );
}
