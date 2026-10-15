import { MotionError, type Vec3 } from "../../shared/motion";
import type { TraversalPolicy } from "../../shared/traversal";
import type { Navigation } from "./navigation";
import { TraversalClearance } from "./traversalClearance";

export interface TraversalLeg {
  kind: "ground" | "jump" | "fly";
  points: Vec3[];
  arc?: number;
}
const length = (a: Vec3, b: Vec3) => Math.hypot(...a.map((v, i) => v - b[i]));
export function jumpArc(a: Vec3, b: Vec3, height: number): Vec3[] {
  return Array.from({ length: 65 }, (_, i) => {
    const u = i / 64;
    return [
      a[0] + (b[0] - a[0]) * u,
      a[1] + (b[1] - a[1]) * u + 4 * height * u * (1 - u),
      a[2] + (b[2] - a[2]) * u,
    ] as Vec3;
  });
}
/** Ground first, bounded static jump links second, explicitly enabled flight last. */
export class TraversalPlanner {
  constructor(
    private nav: Navigation,
    private clearance: TraversalClearance,
    private policy: TraversalPolicy = { fly: false },
  ) {}
  private surface(p: Vec3): Vec3 | null {
    return this.nav.nearest(
      p,
      Math.max(0.35, Math.min(1, this.nav.profile.radius)),
      0.35,
    );
  }
  private ground(a: Vec3, b: Vec3): Vec3[] | null {
    try {
      return this.nav.route(a, b);
    } catch (error) {
      if (
        !(error instanceof MotionError) ||
        !["POINT_NOT_WALKABLE", "TARGET_UNREACHABLE"].includes(error.code)
      )
        throw error;
      return null;
    }
  }
  route(from: Vec3, target: Vec3, forceFlight = false): TraversalLeg[] {
    const a = this.surface(from),
      b = this.surface(target);
    if (a && b && !forceFlight) {
      const route = this.ground(a, b);
      if (route) return [{ kind: "ground", points: route }];
      const jumps = this.jumps(a, b);
      if (jumps) return jumps;
    }
    if (this.policy.fly) {
      const flight = this.flight(a ?? from, b ?? target);
      if (flight) return [{ kind: "fly", points: flight }];
      throw new MotionError(
        "AIR_PATH_BLOCKED",
        "未找到安全的飞行通道：请移开障碍内的标点，或增加空中途经点",
      );
    }
    if (!b)
      throw new MotionError(
        "POINT_NOT_WALKABLE",
        "目标没有足够的可站立表面；悬空目标需要在 NPC 设置中开启飞行，狭窄或障碍内部的点需要重新定位",
      );
    throw new MotionError(
      "TARGET_UNREACHABLE",
      "地面不连通，且未找到能力范围内的安全跳跃路线；请调整点位或为角色开启飞行",
    );
  }
  assertStationary(p: Vec3) {
    if (this.surface(p)) return;
    if (!this.clearance.clearPoint(p))
      throw new MotionError(
        "ACTION_SPACE_BLOCKED",
        "当前位置与地图障碍重叠，请调整标点",
      );
    if (!this.policy.fly)
      throw new MotionError(
        "POINT_NOT_WALKABLE",
        "原地表演需要可站立表面，悬空表演需要开启飞行能力",
      );
  }
  private jumps(a: Vec3, b: Vec3): TraversalLeg[] | null {
    const maxHeight =
      this.policy.jumpHeight ??
      Math.max(1.5, Math.min(4, this.nav.profile.height * 1.5));
    const maxDistance =
      this.policy.jumpDistance ??
      Math.max(3, Math.min(8, this.nav.profile.height * 3));
    const min = a.map(
      (v, i) => Math.min(v, b[i]) - (i === 1 ? maxHeight : maxDistance),
    ) as Vec3;
    const max = a.map(
      (v, i) => Math.max(v, b[i]) + (i === 1 ? maxHeight : maxDistance),
    ) as Vec3;
    const raw = this.nav.candidates(min, max, b);
    // Preserve different floors/components while bounding graph work on large maps.
    const buckets = new Map<string, Vec3>();
    const cell = Math.max(0.6, this.nav.profile.radius);
    for (const p of raw) {
      const component = this.nav.componentAt(p);
      const key = `${component}:${Math.round(p[0] / cell)}:${Math.round(p[2] / cell)}`;
      const previous = buckets.get(key);
      if (
        !previous ||
        Math.min(length(p, a), length(p, b)) <
          Math.min(length(previous, a), length(previous, b))
      )
        buckets.set(key, p);
    }
    const samples = [...buckets.values()].sort(
      (p, q) => length(p, a) + length(p, b) - length(q, a) - length(q, b),
    );
    const groups = new Map<number, Vec3[]>();
    for (const p of samples) {
      const component = this.nav.componentAt(p);
      if (!component) continue;
      const group = groups.get(component) ?? [];
      group.push(p);
      groups.set(component, group);
    }
    const balanced: Vec3[] = [];
    const perGroup = Math.max(4, Math.floor(150 / Math.max(1, groups.size)));
    for (const group of groups.values())
      for (let i = 0, count = Math.min(perGroup, group.length); i < count; i++)
        balanced.push(
          group[Math.round((i * (group.length - 1)) / Math.max(1, count - 1))],
        );
    const nodes = [a, b, ...balanced.slice(0, 150)];
    const components = nodes.map((p) => this.nav.componentAt(p));
    const costs = nodes.map(() => Infinity),
      previous = new Map<number, { index: number; leg: TraversalLeg }>(),
      done = new Set<number>();
    costs[0] = 0;
    let sweepBudget = 200;
    while (done.size < nodes.length) {
      let index = -1;
      for (let i = 0; i < nodes.length; i++)
        if (
          !done.has(i) &&
          Number.isFinite(costs[i]) &&
          (index < 0 ||
            costs[i] + length(nodes[i], b) <
              costs[index] + length(nodes[index], b))
        )
          index = i;
      if (index < 0) return null;
      if (index === 1) {
        const legs: TraversalLeg[] = [];
        for (let i = 1; i !== 0;) {
          const edge = previous.get(i)!;
          legs.unshift(edge.leg);
          i = edge.index;
        }
        return legs.map((leg) =>
          leg.kind === "ground"
            ? {
                ...leg,
                points: this.nav.route(leg.points[0], leg.points.at(-1)!),
              }
            : leg,
        );
      }
      done.add(index);
      const p = nodes[index];
      const neighbors = nodes
        .map((q, i) => ({ q, i, distance: length(p, q) }))
        .filter(
          ({ i, q, distance }) =>
            i !== index &&
            !done.has(i) &&
            (components[i] === components[index] ||
              (Math.hypot(q[0] - p[0], q[2] - p[2]) <= maxDistance &&
                Math.abs(q[1] - p[1]) <= maxHeight)),
        )
        .sort(
          (x, y) => x.distance + length(x.q, b) - y.distance - length(y.q, b),
        );
      for (const { q, i, distance } of neighbors) {
        const ground =
          !!components[index] && components[i] === components[index];
        const cost = costs[index] + distance + (ground ? 0 : 5);
        if (cost >= costs[i]) continue;
        let leg: TraversalLeg;
        if (ground) leg = { kind: "ground", points: [p, q] };
        else {
          if (--sweepBudget < 0) continue;
          // Arc is limited by the actor's rise ability, including the interpolated baseline.
          const arc = Math.max(
            0.3,
            Math.min(
              maxHeight - Math.max(0, q[1] - p[1]),
              0.8 + Math.abs(q[1] - p[1]) * 0.35,
            ),
          );
          const points = jumpArc(p, q, arc);
          if (
            Math.max(...points.map((r) => r[1])) - p[1] > maxHeight + 0.01 ||
            !this.clearance.clearPath(points)
          )
            continue;
          leg = { kind: "jump", points: [p, q], arc };
        }
        costs[i] = cost;
        previous.set(i, { index, leg });
      }
    }
    return null;
  }
  private flight(a: Vec3, b: Vec3): Vec3[] | null {
    if (!this.clearance.clearPoint(a) || !this.clearance.clearPoint(b))
      return null;
    if (this.clearance.clearPath([a, b])) return [a, b];
    const maxY = Math.max(a[1], b[1]);
    const offset = Math.max(1, this.nav.profile.radius * 3);
    const shifts: [number, number][] = [
      [0, 0],
      [offset, 0],
      [-offset, 0],
      [0, offset],
      [0, -offset],
    ];
    for (const lift of [2, 4, 8, 16, 32, 48])
      for (const [x, z] of shifts) {
        const first: Vec3 = [a[0] + x, a[1], a[2] + z];
        const last: Vec3 = [b[0] + x, b[1], b[2] + z];
        const points: Vec3[] = [
          a,
          first,
          [first[0], maxY + lift, first[2]],
          [last[0], maxY + lift, last[2]],
          last,
          b,
        ];
        if (this.clearance.clearPath(points))
          return points.filter((p, i) => !i || length(p, points[i - 1]) > 1e-6);
      }
    return null;
  }
}
