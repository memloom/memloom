// Pure render helpers ported from a production graph canvas implementation.
// No React, no DOM — deterministic scatter, color math, and label placement.

export type LabelAnchor = "right" | "left" | "top" | "bottom";

export interface PositionedNode {
  id: string;
  x?: number;
  y?: number;
}

export function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

// Deterministic 0..1 from a string — used to scatter nodes to stable home positions.
export function stable01(input: string) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return ((hash >>> 0) % 10000) / 10000;
}

export function getLinkEndpointId(endpoint: string | { id: string }): string {
  return typeof endpoint === "string" ? endpoint : endpoint.id;
}

export function scaleColorAlpha(color: string, scale: number) {
  const rgba = color.match(/^rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\)$/i);
  if (rgba) {
    const red = Number(rgba[1] ?? 0);
    const green = Number(rgba[2] ?? 0);
    const blue = Number(rgba[3] ?? 0);
    const alpha = rgba[4] ? Number(rgba[4]) : 1;
    return `rgba(${red}, ${green}, ${blue}, ${Math.max(0.06, Math.min(1, alpha * scale)).toFixed(3)})`;
  }

  const hex = color.match(/^#([0-9a-f]{6})$/i);
  const raw = hex?.[1];
  if (raw) {
    const red = parseInt(raw.slice(0, 2), 16);
    const green = parseInt(raw.slice(2, 4), 16);
    const blue = parseInt(raw.slice(4, 6), 16);
    return `rgba(${red}, ${green}, ${blue}, ${Math.max(0.06, Math.min(1, scale)).toFixed(3)})`;
  }

  return color;
}

export function mixColors(from: string, to: string, mix: number) {
  const clampMix = clamp01(mix);

  const parseColor = (input: string) => {
    const rgba = input.match(/^rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\)$/i);
    if (rgba) {
      return {
        red: Number(rgba[1] ?? 0),
        green: Number(rgba[2] ?? 0),
        blue: Number(rgba[3] ?? 0),
        alpha: rgba[4] ? Number(rgba[4]) : 1,
      };
    }
    const hex = input.match(/^#([0-9a-f]{6})$/i);
    const raw = hex?.[1];
    if (raw) {
      return {
        red: parseInt(raw.slice(0, 2), 16),
        green: parseInt(raw.slice(2, 4), 16),
        blue: parseInt(raw.slice(4, 6), 16),
        alpha: 1,
      };
    }
    return null;
  };

  const fromColor = parseColor(from);
  const toColor = parseColor(to);
  if (!fromColor || !toColor) {
    return clampMix >= 0.5 ? to : from;
  }

  const blendChannel = (start: number, end: number) => Math.round(start + (end - start) * clampMix);
  const alpha = fromColor.alpha + (toColor.alpha - fromColor.alpha) * clampMix;

  return `rgba(${blendChannel(fromColor.red, toColor.red)}, ${blendChannel(fromColor.green, toColor.green)}, ${blendChannel(fromColor.blue, toColor.blue)}, ${alpha.toFixed(3)})`;
}

// Pick the side to draw a node's label on — away from its neighbors and outward from
// the graph center, so labels collide as little as possible.
export function pickLabelAnchor<T extends PositionedNode>(
  node: T,
  neighborMap: Map<string, Set<string>>,
  nodeMap: Map<string, T>,
): LabelAnchor {
  const neighbors = neighborMap.get(node.id);
  if (!neighbors || neighbors.size === 0) {
    return Math.abs(node.x ?? 0) >= Math.abs(node.y ?? 0)
      ? (node.x ?? 0) >= 0
        ? "right"
        : "left"
      : (node.y ?? 0) >= 0
        ? "bottom"
        : "top";
  }

  const counts: Record<LabelAnchor, number> = { right: 0, left: 0, top: 0, bottom: 0 };
  const nodeX = node.x ?? 0;
  const nodeY = node.y ?? 0;

  neighbors.forEach((neighborId) => {
    const neighbor = nodeMap.get(neighborId);
    if (!neighbor) return;
    const dx = (neighbor.x ?? 0) - nodeX;
    const dy = (neighbor.y ?? 0) - nodeY;
    if (Math.abs(dx) >= Math.abs(dy)) {
      counts[dx >= 0 ? "right" : "left"] += 1;
    } else {
      counts[dy >= 0 ? "bottom" : "top"] += 1;
    }
  });

  const outwardPreferred: LabelAnchor =
    Math.abs(nodeX) >= Math.abs(nodeY)
      ? nodeX >= 0
        ? "right"
        : "left"
      : nodeY >= 0
        ? "bottom"
        : "top";

  let best: LabelAnchor = "right";
  let bestScore = Number.NEGATIVE_INFINITY;
  (["right", "left", "top", "bottom"] as LabelAnchor[]).forEach((anchor) => {
    let score = -counts[anchor] * 2;
    if (anchor === outwardPreferred) score += 1;
    if (anchor === "right" || anchor === "left") score += 0.05;
    if (score > bestScore) {
      bestScore = score;
      best = anchor;
    }
  });

  return best;
}
