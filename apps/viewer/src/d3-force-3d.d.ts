// d3-force-3d ships no types; this is the minimal surface GraphView uses.
declare module "d3-force-3d" {
  export interface ForceCollide<N> {
    (alpha: number): void;
    radius(value: number | ((node: N) => number)): ForceCollide<N>;
    strength(value: number): ForceCollide<N>;
    iterations(value: number): ForceCollide<N>;
  }
  export function forceCollide<N = unknown>(
    radius?: number | ((node: N) => number),
  ): ForceCollide<N>;
}
