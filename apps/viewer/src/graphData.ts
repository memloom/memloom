import type { DocumentChunks, Graph } from "./api";
import type { GraphNodeKind, GraphRelation, ViewerGraphConfig } from "./graphConfig";
import { clamp01, getLinkEndpointId, type LabelAnchor, stable01 } from "./graphRender";
import type { ScopeSelection } from "./ScopeTree";

// The shared graph model behind both renderers: the palette, the node/link shapes, and
// buildGraphData, which turns the API payload into simulation-ready nodes and links.
// The 2D canvas and the 3D scene draw the same build; only the renderer differs.

export type Palette = Record<
  | "memory"
  | "entity"
  | "document"
  | "chunk"
  | "linkBase"
  | "mention"
  | "replaces"
  | "distinct"
  | "chunkLink"
  | "linkDim"
  | "label"
  | "selectedStroke",
  string
>;

export const PALETTES: Record<"dark" | "light", Palette> = {
  dark: {
    memory: "#38bdf8",
    entity: "#c084fc",
    document: "#34d399",
    chunk: "#6ee7b7",
    linkBase: "rgba(148, 163, 184, 0.45)",
    mention: "rgba(192, 132, 252, 0.5)",
    // Version lineage is indigo. Amber is reserved for chrome/identity (DESIGN.md).
    replaces: "rgba(93, 103, 245, 0.65)",
    distinct: "rgba(45, 212, 191, 0.5)",
    chunkLink: "rgba(52, 211, 153, 0.45)",
    linkDim: "rgba(148, 163, 184, 0.08)",
    label: "#e2e8f0",
    selectedStroke: "rgba(255, 255, 255, 0.92)",
  },
  light: {
    memory: "#0284c7",
    entity: "#9333ea",
    document: "#059669",
    chunk: "#10b981",
    linkBase: "rgba(120, 113, 108, 0.5)",
    mention: "rgba(147, 51, 234, 0.45)",
    replaces: "rgba(79, 70, 229, 0.7)",
    distinct: "rgba(13, 148, 136, 0.55)",
    chunkLink: "rgba(5, 150, 105, 0.4)",
    linkDim: "rgba(120, 113, 108, 0.12)",
    label: "#44403c",
    selectedStroke: "rgba(28, 25, 23, 0.92)",
  },
};

export function relationColor(pal: Palette, relation: GraphRelation): string {
  if (relation === "mention") return pal.mention;
  if (relation === "replaces") return pal.replaces;
  if (relation === "distinct") return pal.distinct;
  if (relation === "chunk") return pal.chunkLink;
  return pal.linkBase;
}

export const NODE_BASE_SIZE: Record<GraphNodeKind, number> = {
  memory: 6,
  entity: 7,
  document: 8,
  chunk: 4.5,
};

export interface Node {
  id: string;
  kind: GraphNodeKind;
  label: string;
  full: string;
  size: number;
  homeX?: number;
  homeY?: number;
  /** Only in the 3D build; the 2D build leaves the z fields untouched. */
  homeZ?: number;
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
  fx?: number;
  fy?: number;
  fz?: number;
  /** Cached label side; recomputed while the simulation moves nodes, frozen when settled. */
  labelAnchor?: LabelAnchor;
}

export interface Link {
  source: string | Node;
  target: string | Node;
  relation: GraphRelation;
  /** The raw relation string: typed predicates (works_on, uses, ...) keep their name here. */
  label: string;
  weight: number;
}

// Structural relations the engine writes itself; everything else is a typed predicate the
// extractor stated (subject -> predicate -> object), which is what earns a label + arrow.
const STRUCTURAL_RELATIONS = new Set(["mention", "mentions", "replaces", "distinct", "chunk"]);

export function isPredicateLink(link: Link): boolean {
  return !STRUCTURAL_RELATIONS.has(link.label);
}

export type CachedNodePosition = Pick<
  Node,
  "x" | "y" | "z" | "vx" | "vy" | "vz" | "homeX" | "homeY" | "homeZ"
>;

/** Node and link instances reused across rebuilds, keyed by id (links by
    source|target|label). Both renderers join data by object identity, so handing back
    the same instances means a rebuild updates the scene incrementally instead of
    tearing down and recreating every three.js object and canvas sprite. One registry
    per renderer: instances carry renderer-private state (sim velocities, the 3D z axis,
    the lib's own bind attributes) that must not leak across modes. */
export interface GraphRegistry {
  nodes: Map<string, Node>;
  links: Map<string, Link>;
}

export function toRelation(relation: string): GraphRelation {
  if (relation === "mention" || relation === "mentions") return "mention";
  if (relation === "replaces") return "replaces";
  if (relation === "distinct") return "distinct";
  if (relation === "chunk") return "chunk";
  return "default";
}

export function getCenterLayoutSpreadMultiplier(centerForce: number) {
  return 1.85 - clamp01(centerForce) * 1.1;
}

export function getAnchorStrength(centerForce: number) {
  const compactness = clamp01(centerForce);
  return 0.05 * (0.72 + compactness * 1.35);
}

export function buildGraphData(
  graph: Graph,
  expanded: Map<string, DocumentChunks>,
  config: ViewerGraphConfig,
  activeId: string | null,
  /** Entities a traverse answer names. Revealed even with "show entities" off, or the
      dimming would darken the canvas and leave nothing lit to look at. */
  traverseIds: Set<string> | null,
  /** The folder filter from the controls panel; null shows everything. */
  scopeFilter: ScopeSelection | null,
  /** Positions survive data rebuilds (expand/collapse, 15s refetch, renderer switch) so
      the layout never re-randomizes under the user. Each renderer owns its own cache. */
  cache: Map<string, CachedNodePosition>,
  /** Instance reuse across rebuilds; must belong to the same renderer as the cache. */
  registry: GraphRegistry,
  /** The 3D build scatters homes on a sphere instead of a circle and seeds z. */
  threeD: boolean,
) {
  const sizeMul = config.display.nodeSizeMultiplier;
  const spread = getCenterLayoutSpreadMultiplier(config.forces.centerForce);
  // The folder filter, applied to the payload before anything is built. Null (or absent)
  // scope ids read as 'uncategorized', matching the engine's read side.
  const scopeIds = scopeFilter ? new Set(scopeFilter.ids) : null;
  const inScope = (scopeId: string | null | undefined) =>
    scopeIds === null
      ? true
      : scopeId == null
        ? (scopeFilter?.includeUnscoped ?? false)
        : scopeIds.has(scopeId);
  const memories = graph.memories.filter((m) => inScope(m.scopeId));
  const documents = graph.documents.filter((d) => inScope(d.scopeId));
  const docIds = new Set(documents.map((d) => d.id));
  const openDocs = [...expanded].filter(([id]) => docIds.has(id));
  const openIds = new Set(openDocs.map(([id]) => id));

  // Entities stay global, so the folder filter keeps only those with at least one visible
  // mention source; an entity whose every source is filtered out would float context-free.
  let scopedEntities: Set<string> | null = null;
  if (scopeIds !== null) {
    scopedEntities = new Set();
    const visibleSources = new Set<string>([
      ...memories.map((m) => m.id),
      ...documents.map((d) => d.id),
    ]);
    for (const [, dc] of openDocs) for (const c of dc.chunks) visibleSources.add(c.id);
    const mark = (from: string, to: string) => {
      if (visibleSources.has(from)) scopedEntities?.add(to);
      if (visibleSources.has(to)) scopedEntities?.add(from);
    };
    for (const e of graph.edges) mark(e.from, e.to);
    for (const [, dc] of openDocs) for (const e of dc.edges) mark(e.from, e.to);
  }

  // With "show entities" off, only entities touching the active (selected) node exist.
  // Their edges vanish with them. The link builders below skip absent endpoints.
  let revealedEntities: Set<string> | null = null;
  if (!config.display.showEntities) {
    revealedEntities = new Set();
    if (traverseIds) for (const id of traverseIds) revealedEntities.add(id);
    if (activeId) {
      revealedEntities.add(activeId);
      const reveal = (from: string, to: string) => {
        if (from === activeId) revealedEntities?.add(to);
        if (to === activeId) revealedEntities?.add(from);
      };
      for (const e of graph.edges) reveal(e.from, e.to);
      for (const [, dc] of openDocs) for (const e of dc.edges) reveal(e.from, e.to);
    }
  }

  const nodes: Node[] = [];
  const nodeMap = new Map<string, Node>();

  const addNode = (node: Node) => {
    // An unchanged node keeps its prior instance (with its live position, velocity, and
    // the renderer's scene object bound to it). A changed one gets this fresh instance,
    // which the renderer will rebuild; carry the motion state over so it doesn't jump.
    const prior = registry.nodes.get(node.id);
    if (
      prior &&
      prior.kind === node.kind &&
      prior.label === node.label &&
      prior.full === node.full &&
      prior.size === node.size
    ) {
      nodeMap.set(prior.id, prior);
      nodes.push(prior);
      return;
    }
    const previous = prior ?? cache.get(node.id);
    if (previous) {
      node.x = previous.x;
      node.y = previous.y;
      node.vx = previous.vx;
      node.vy = previous.vy;
      if (previous.homeX !== undefined) node.homeX = previous.homeX;
      if (previous.homeY !== undefined) node.homeY = previous.homeY;
      if (threeD) {
        node.z = previous.z;
        node.vz = previous.vz;
        if (previous.homeZ !== undefined) node.homeZ = previous.homeZ;
      }
    }
    registry.nodes.set(node.id, node);
    nodeMap.set(node.id, node);
    nodes.push(node);
  };

  // 2D scatters homes on a disc; 3D on a sphere (uniform via acos), so the cloud has
  // depth to orbit through instead of being a plane viewed edge-on.
  const scatterHome = (id: string) => {
    const angle = stable01(id) * Math.PI * 2;
    const radial = (150 + stable01(`${id}:r`) * 220) * spread;
    if (!threeD) {
      return { homeX: Math.cos(angle) * radial, homeY: Math.sin(angle) * radial };
    }
    const polar = Math.acos(2 * stable01(`${id}:p`) - 1);
    return {
      homeX: radial * Math.sin(polar) * Math.cos(angle),
      homeY: radial * Math.sin(polar) * Math.sin(angle),
      homeZ: radial * Math.cos(polar),
    };
  };

  const seedNode = (node: Node & { homeX?: number; homeY?: number; homeZ?: number }) => {
    node.x = node.homeX;
    node.y = node.homeY;
    if (threeD) node.z = node.homeZ;
    addNode(node);
  };

  for (const m of memories) {
    seedNode({
      id: m.id,
      kind: "memory",
      label: m.canonical ?? m.content,
      full: m.content,
      size: NODE_BASE_SIZE.memory * sizeMul,
      ...scatterHome(m.id),
    });
  }
  for (const e of graph.entities) {
    if (revealedEntities && !revealedEntities.has(e.id)) continue;
    if (scopedEntities && !scopedEntities.has(e.id)) continue;
    seedNode({
      id: e.id,
      kind: "entity",
      label: e.name,
      full: `${e.name} (${e.entityType})`,
      size: NODE_BASE_SIZE.entity * sizeMul,
      ...scatterHome(e.id),
    });
  }
  for (const d of documents) {
    seedNode({
      id: d.id,
      kind: "document",
      label: d.title,
      full: d.path,
      size: NODE_BASE_SIZE.document * sizeMul,
      ...scatterHome(d.id),
    });
  }
  // Chunks bloom around their parent document's LIVE position (phyllotaxis spiral), so an
  // expansion appears where the document is, rather than somewhere random.
  for (const [docId, dc] of openDocs) {
    const parent = cache.get(docId) ?? nodeMap.get(docId);
    const px = parent?.x ?? 0;
    const py = parent?.y ?? 0;
    const pz = parent?.z ?? 0;
    dc.chunks.forEach((c, i) => {
      const r = (18 + 6 * Math.sqrt(i)) * Math.min(spread, 1.2);
      const a = i * 2.399963;
      const home = threeD
        ? {
            homeX: px + r * Math.cos(a),
            homeY: py + r * Math.sin(a),
            homeZ: pz + (stable01(`${c.id}:z`) - 0.5) * r,
          }
        : { homeX: px + r * Math.cos(a), homeY: py + r * Math.sin(a) };
      seedNode({
        id: c.id,
        kind: "chunk",
        label: c.headingPath ?? `#${c.chunkIndex + 1}`,
        full: c.content,
        size: NODE_BASE_SIZE.chunk * sizeMul,
        ...home,
      });
    });
  }

  const rawLinks: Link[] = [
    // An expanded document swaps its rolled-up mention edges for the chunk-level truth.
    ...graph.edges
      .filter((e) => !(openIds.has(e.from) && e.relation === "mention"))
      .filter((e) => nodeMap.has(e.from) && nodeMap.has(e.to))
      .map((e) => ({
        source: e.from,
        target: e.to,
        relation: toRelation(e.relation),
        label: e.relation,
        weight: e.weight ?? 1,
      })),
    ...openDocs.flatMap(([docId, dc]) => [
      ...dc.chunks.map((c) => ({
        source: docId,
        target: c.id,
        relation: "chunk" as const,
        label: "chunk",
        weight: 1,
      })),
      ...dc.edges
        .filter((e) => nodeMap.has(e.from) && nodeMap.has(e.to))
        .map((e) => ({
          source: e.from,
          target: e.to,
          relation: toRelation(e.relation),
          label: e.relation,
          weight: 1,
        })),
    ]),
  ];

  // Parallel typed predicates between the same pair (Gniezno located_in AND part_of
  // Poland) are legal in the store, but drawn separately they overprint: two identical
  // lines, two stacked arrowheads, two labels smeared into garbage at the midpoint.
  // Merge same-direction predicate links into one, with the names joined in the label.
  const links: Link[] = [];
  const predicateByPair = new Map<string, Link>();
  for (const link of rawLinks) {
    if (!isPredicateLink(link)) {
      links.push(link);
      continue;
    }
    const key = `${link.source}|${link.target}`;
    const prior = predicateByPair.get(key);
    if (prior) {
      if (!prior.label.split(", ").includes(link.label)) {
        prior.label = `${prior.label}, ${link.label}`;
      }
      prior.weight = Math.max(prior.weight, link.weight);
    } else {
      predicateByPair.set(key, link);
      links.push(link);
    }
  }

  // Same reuse for links, keyed by endpoints plus the (merged) label. Endpoints are
  // always re-pointed at the current node instances: a changed node got a fresh
  // instance above, and a reused link must not keep steering the old one.
  const finalLinks = links.map((link) => {
    const s = getLinkEndpointId(link.source);
    const t = getLinkEndpointId(link.target);
    const key = `${s}|${t}|${link.label}`;
    const prior = registry.links.get(key);
    const kept =
      prior && prior.relation === link.relation && prior.weight === link.weight ? prior : link;
    if (kept === link) registry.links.set(key, link);
    kept.source = nodeMap.get(s) ?? kept.source;
    kept.target = nodeMap.get(t) ?? kept.target;
    return kept;
  });

  const neighborMap = new Map<string, Set<string>>();
  for (const node of nodes) neighborMap.set(node.id, new Set());
  for (const link of finalLinks) {
    const s = getLinkEndpointId(link.source);
    const t = getLinkEndpointId(link.target);
    neighborMap.get(s)?.add(t);
    neighborMap.get(t)?.add(s);
  }

  // chunk id -> parent document id, for the side panel's breadcrumb.
  const chunkParent = new Map<string, string>();
  for (const [docId, dc] of openDocs) for (const c of dc.chunks) chunkParent.set(c.id, docId);

  return { graphData: { nodes, links: finalLinks }, nodeMap, neighborMap, chunkParent };
}
