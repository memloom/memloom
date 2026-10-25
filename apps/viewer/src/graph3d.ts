import * as THREE from "three";
import SpriteText from "three-spritetext";
import type { Node, Palette } from "./graphData";
import { scaleColorAlpha } from "./graphRender";

// Three.js helpers for the 3D graph mode: node object construction (the pixel-motif in
// solid form: memories are cubes, entities spheres, documents octahedra), material
// styling for hover/selection/traverse, and the camera moves the 2D zoom API doesn't
// have. No React here; GraphView calls these from its 3D branch.

const BASE_OPACITY = 0.92;

export interface NodeObject3D {
  group: THREE.Group;
  material: THREE.MeshLambertMaterial;
  sprite: SpriteText | null;
  baseColor: string;
}

// One unit-size geometry per kind, shared by every node of that kind and scaled on the
// mesh; thousands of per-node copies of the same sphere are pure waste. The library
// disposes a removed node's geometry (it assumes ownership), so shared geometries get a
// no-op dispose and live for the session.
const GEOMETRIES = new Map<Node["kind"], THREE.BufferGeometry>();

function geometryFor(kind: Node["kind"]): THREE.BufferGeometry {
  let geometry = GEOMETRIES.get(kind);
  if (!geometry) {
    if (kind === "entity") geometry = new THREE.SphereGeometry(0.85, 24, 16);
    else if (kind === "document") geometry = new THREE.OctahedronGeometry(1.2);
    else {
      const side = kind === "chunk" ? 1.3 : 1.5;
      geometry = new THREE.BoxGeometry(side, side, side);
    }
    geometry.dispose = () => {};
    GEOMETRIES.set(kind, geometry);
  }
  return geometry;
}

// SpriteText rasters at 90px by default; at that size 1500 labels are over a gigabyte
// of canvas textures. Labels render small on screen, so 40px is indistinguishable.
const LABEL_RASTER_PX = 40;

export function makeNodeObject(node: Node, pal: Palette, withLabel: boolean): NodeObject3D {
  const color = pal[node.kind];
  const material = new THREE.MeshLambertMaterial({
    color,
    transparent: true,
    opacity: BASE_OPACITY,
  });
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(geometryFor(node.kind), material);
  mesh.scale.setScalar(node.size);
  group.add(mesh);
  let sprite: SpriteText | null = null;
  if (withLabel) {
    const text = node.label.length > 32 ? `${node.label.slice(0, 29)}...` : node.label;
    sprite = new SpriteText(text);
    sprite.fontSize = LABEL_RASTER_PX;
    sprite.color = pal.label;
    sprite.textHeight = Math.max(2.6, node.size * 0.5);
    sprite.position.y = node.size * 1.7 + 2;
    // Labels are annotations, not occluders: never block the depth buffer.
    sprite.material.depthWrite = false;
    group.add(sprite);
  }
  return { group, material, sprite, baseColor: color };
}

/** A relation-name sprite drawn at a link's midpoint (linkThreeObjectExtend mode). */
export function makeLinkSprite(label: string, pal: Palette): SpriteText {
  const sprite = new SpriteText(label);
  sprite.fontSize = LABEL_RASTER_PX;
  sprite.color = scaleColorAlpha(pal.label, 0.8);
  sprite.textHeight = 2.4;
  sprite.material.depthWrite = false;
  return sprite;
}

/**
 * One idempotent pass over every node object: hover pulls the node and its neighbors
 * forward and dims the rest, selection holds brand color and scale, a traverse answer
 * mutes everything outside it hardest of all. Called on the events that change any of
 * those, mutating materials in place so no React render or object rebuild happens.
 */
export function styleNodeObjects(
  objects: Map<string, NodeObject3D>,
  opts: {
    hoverId: string | null;
    neighbors: Set<string>;
    selectedId: string | null;
    traverse: Set<string> | null;
    brand: string;
  },
): void {
  const brand = new THREE.Color(opts.brand);
  for (const [id, obj] of objects) {
    const outside = opts.traverse != null && !opts.traverse.has(id);
    const isHover = opts.hoverId === id;
    const isSelected = opts.selectedId === id;
    const isNeighbor = opts.neighbors.has(id);
    const dimmed = outside || (opts.hoverId != null && !isHover && !isNeighbor && !isSelected);
    obj.material.opacity = outside ? 0.07 : dimmed ? 0.22 : BASE_OPACITY;
    obj.material.color.set(obj.baseColor);
    if (isHover || isSelected) obj.material.color.lerp(brand, isHover ? 0.6 : 0.45);
    obj.group.scale.setScalar(isSelected ? 1.28 : isHover ? 1.18 : 1);
    if (obj.sprite) obj.sprite.visible = !outside && !dimmed;
  }
}

// The imperative camera handle react-force-graph-3d exposes; kept loose like fgRef.
// biome-ignore lint/suspicious/noExplicitAny: untyped imperative handle from the lib
type ForceGraph3DHandle = any;

/** Dolly the camera toward (factor > 1) or away from the orbit target. */
export function zoomCamera(fg: ForceGraph3DHandle, factor: number, ms = 220): void {
  const cam = fg?.camera?.();
  if (!cam) return;
  const target = fg.controls?.()?.target ?? { x: 0, y: 0, z: 0 };
  const dx = cam.position.x - target.x;
  const dy = cam.position.y - target.y;
  const dz = cam.position.z - target.z;
  const distance = Math.hypot(dx, dy, dz) || 1;
  const scale = Math.min(4000, Math.max(24, distance / factor)) / distance;
  fg.cameraPosition?.(
    { x: target.x + dx * scale, y: target.y + dy * scale, z: target.z + dz * scale },
    target,
    ms,
  );
}

/** Fly the camera to a node and look at it: the click-to-inspect move. */
export function flyToNode(
  fg: ForceGraph3DHandle,
  node: { x?: number; y?: number; z?: number },
  ms = 900,
): void {
  const x = node.x ?? 0;
  const y = node.y ?? 0;
  const z = node.z ?? 0;
  const length = Math.hypot(x, y, z);
  // A node at the origin has no outward direction; approach along z instead.
  if (length < 1) {
    fg?.cameraPosition?.({ x, y, z: z + 160 }, { x, y, z }, ms);
    return;
  }
  const ratio = 1 + 160 / length;
  fg?.cameraPosition?.({ x: x * ratio, y: y * ratio, z: z * ratio }, { x, y, z }, ms);
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** The hover tooltip: node kind plus content, HTML-escaped (memory content is user data). */
export function nodeTooltipHtml(node: Node): string {
  const body = node.full.length > 240 ? `${node.full.slice(0, 237)}...` : node.full;
  return `<div class="graph3dTooltip"><span class="graph3dTooltipKind">${node.kind}</span>${escapeHtml(body)}</div>`;
}
