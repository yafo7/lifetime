import type { Vec3 } from "../../shared/motion";

export const distance = (a: Vec3, b: Vec3) =>
  Math.hypot(...a.map((v, i) => v - b[i]));
export const pointKey = (p: Vec3) => p.map((v) => v.toFixed(3)).join(",");

/** Choose a whole route, rather than greedily snapping each waypoint to an island.
 * Costs must come from real navigation; null means unreachable, never a straight line.
 */
export function connectedSequence(
  layers: Vec3[][],
  cost: (a: Vec3, b: Vec3) => number | null,
  options: {
    from?: Vec3;
    closed?: boolean;
    check?: () => void;
    entryCost?: (p: Vec3) => number;
  } = {},
): Vec3[] | null {
  if (!layers.length || layers.some((layer) => !layer.length)) return null;
  let best: { score: number; points: Vec3[] } | undefined;
  const starts = options.closed ? layers[0].map((_, i) => i) : [-1];
  for (const start of starts) {
    let states = layers[0].map((p, i) => {
      const arrival = options.from ? cost(options.from, p) : 0;
      return {
        score:
          (start < 0 || start === i) && arrival !== null
            ? arrival + i * 0.05 + (options.entryCost?.(p) ?? 0)
            : Infinity,
        indices: [i],
      };
    });
    for (let layer = 1; layer < layers.length; layer++) {
      options.check?.();
      states = layers[layer].map((p, i) => {
        let next = { score: Infinity, indices: [] as number[] };
        states.forEach((prev, j) => {
          if (!Number.isFinite(prev.score)) return;
          const edge = cost(layers[layer - 1][j], p);
          if (edge !== null && prev.score + edge + i * 0.05 < next.score)
            next = {
              score: prev.score + edge + i * 0.05,
              indices: [...prev.indices, i],
            };
        });
        return next;
      });
    }
    states.forEach((state, i) => {
      if (!Number.isFinite(state.score)) return;
      const close = options.closed
        ? cost(layers.at(-1)![i], layers[0][start])
        : 0;
      if (close === null) return;
      const score = state.score + close;
      if (!best || score < best.score)
        best = {
          score,
          points: state.indices.map((index, layer) => layers[layer][index]),
        };
    });
  }
  return best?.points ?? null;
}

/** Convex envelope keeps a circuit outside every lobe of a concave water body. */
export function convexBoundary(points: [number, number][]): [number, number][] {
  const sorted = [
    ...new Map(points.map((p) => [p.join(","), p])).values(),
  ].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (a: number[], b: number[], c: number[]) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const half = (list: [number, number][]) => {
    const out: [number, number][] = [];
    for (const p of list) {
      while (out.length > 1 && cross(out.at(-2)!, out.at(-1)!, p) <= 0)
        out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

/** Offset each corner using the two outward edge normals, preserving polygon shape. */
export function offsetBoundary(
  hull: [number, number][],
  margin: number,
): [number, number][] {
  return hull.map((p, i) => {
    const before = hull[(i + hull.length - 1) % hull.length],
      after = hull[(i + 1) % hull.length];
    const normal = (a: number[], b: number[]) => {
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      return [(b[1] - a[1]) / length, (a[0] - b[0]) / length];
    };
    const a = normal(before, p),
      b = normal(p, after),
      divisor = Math.max(0.1, 1 + a[0] * b[0] + a[1] * b[1]);
    return [
      p[0] + (margin * (a[0] + b[0])) / divisor,
      p[1] + (margin * (a[1] + b[1])) / divisor,
    ];
  });
}

export function winding(points: Vec3[], center: Vec3): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    total += Math.atan2(
      (a[0] - center[0]) * (b[2] - center[2]) -
        (a[2] - center[2]) * (b[0] - center[0]),
      (a[0] - center[0]) * (b[0] - center[0]) +
        (a[2] - center[2]) * (b[2] - center[2]),
    );
  }
  return total;
}

/** Reject even a short segment crossing a thin inlet between navigation samples. */
export function crossesBoundary(
  a: Vec3,
  b: Vec3,
  boundary: [number, number][],
): boolean {
  const side = (x: number[], y: number[], z: number[]) =>
    (y[0] - x[0]) * (z[1] - x[1]) - (y[1] - x[1]) * (z[0] - x[0]);
  const start = [a[0], a[2]],
    end = [b[0], b[2]];
  return boundary.some((c, i) => {
    const d = boundary[(i + 1) % boundary.length];
    return (
      side(start, end, c) * side(start, end, d) < -1e-10 &&
      side(c, d, start) * side(c, d, end) < -1e-10
    );
  });
}
