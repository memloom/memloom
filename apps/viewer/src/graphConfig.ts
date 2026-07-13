// The controllable physics/display shape for the viewer graph — a proven
// graph-config pattern adapted to memloom's node kinds (memory, entity, document,
// chunk) and relations. Scalar fields drive the GraphControlsPanel sliders; the per-kind
// and per-relation maps stay off the panel surface but tune how each species behaves.

export type GraphNodeKind = "memory" | "entity" | "document" | "chunk";
export type GraphRelation = "mention" | "replaces" | "distinct" | "chunk" | "default";
// What gets a name drawn along the edge: nothing, typed predicate edges only (works_on,
// uses, ...), or every edge including structural ones (mention, chunk, replaces).
export type EdgeLabelMode = "off" | "predicates" | "all";

export type ViewerGraphConfig = {
  display: {
    nodeSizeMultiplier: number;
    linkThicknessMultiplier: number;
    labelFadeThreshold: number;
    edgeLabels: EdgeLabelMode;
  };
  forces: {
    centerForce: number;
    repelForce: number;
    linkForce: number;
    linkDistance: number;
    velocityDecay: number;
    alphaDecay: number;
    alphaMin: number;
    cooldownTicks: number;
    chargeDistanceMax: number;
    chargeTheta: number;
    nodeRepulsionMultiplier: Record<GraphNodeKind, number>;
    linkDistanceMultiplier: Record<GraphRelation, number>;
    linkStrengthMultiplier: Record<GraphRelation, number>;
    collisionRadiusMultiplier: Record<GraphNodeKind, number>;
  };
};

export const DEFAULT_GRAPH_CONFIG: ViewerGraphConfig = {
  display: {
    nodeSizeMultiplier: 1,
    linkThicknessMultiplier: 1,
    labelFadeThreshold: 1,
    // Labeling mention/chunk edges would print the same word hundreds of times — typed
    // predicate edges are the ones whose name carries information.
    edgeLabels: "predicates",
  },
  forces: {
    centerForce: 0.5,
    repelForce: 700,
    linkForce: 0.5,
    linkDistance: 110,
    velocityDecay: 0.43,
    alphaDecay: 0.024,
    alphaMin: 0.0012,
    cooldownTicks: 320,
    chargeDistanceMax: 1400,
    chargeTheta: 0.9,
    // Chunks barely repel — a 46-chunk PDF must bloom around its document, not detonate
    // the neighborhood. Documents push a little harder so their blooms get room.
    nodeRepulsionMultiplier: {
      memory: 1,
      entity: 1.15,
      document: 1.2,
      chunk: 0.12,
    },
    // Chunk tethers are short and stiff so blooms hold their shape; replaces (lineage)
    // pulls versions close; distinct keeps deliberately-separate memories apart.
    linkDistanceMultiplier: {
      mention: 0.9,
      replaces: 0.8,
      distinct: 1.05,
      chunk: 0.22,
      default: 1,
    },
    linkStrengthMultiplier: {
      mention: 0.85,
      replaces: 1.25,
      distinct: 0.9,
      chunk: 1.6,
      default: 1,
    },
    collisionRadiusMultiplier: {
      memory: 1.1,
      entity: 1.15,
      document: 1.15,
      chunk: 1,
    },
  },
};

export function cloneGraphConfig(config: ViewerGraphConfig): ViewerGraphConfig {
  return {
    display: { ...config.display },
    forces: {
      ...config.forces,
      nodeRepulsionMultiplier: { ...config.forces.nodeRepulsionMultiplier },
      linkDistanceMultiplier: { ...config.forces.linkDistanceMultiplier },
      linkStrengthMultiplier: { ...config.forces.linkStrengthMultiplier },
      collisionRadiusMultiplier: { ...config.forces.collisionRadiusMultiplier },
    },
  };
}
