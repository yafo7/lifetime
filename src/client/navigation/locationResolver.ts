import {
  pointPosition,
  MotionError,
  type ActionPoint,
  type Vec3,
} from "../../shared/motion";
import type { LocationIntent } from "../../shared/mapSemantics";
import { SurfacePicker, pointOnSurface } from "../rendering/surfacePicker";
import { mapSpace } from "../../shared/sceneMotion";
import { sampleTerrainHeight } from "../rendering/map/shared/map";
import {
  isPointInsideWaterBody,
  waterBoundaryPoints,
} from "../rendering/map/shared/mapWater";
import type { SemanticIndex, SpatialFeature } from "./semanticIndex";
import type { SceneGeometry } from "./geometry";
import type { Navigation } from "./navigation";
import { jumpArc, type TraversalPlanner } from "./traversalPlanner";
import {
  connectedSequence,
  convexBoundary,
  offsetBoundary,
  distance,
  pointKey,
  winding,
  crossesBoundary,
} from "./regionSearch";

export interface ResolvedLocation {
  intent: LocationIntent;
  points: ActionPoint[];
  closed: boolean;
}
const position = (f: SpatialFeature): Vec3 =>
  f.min.map((v, i) => (v + f.max[i]) / 2) as Vec3;
type Candidate = { position: Vec3; point: ActionPoint; score: number };

/** AI names the place and relation; geometry, candidates and routes stay local. */
export class LocationResolver {
  private surfaces: SurfacePicker;
  private count = 0;
  private from?: Vec3;
  private paths = new Map<string, number | null>();
  private anchors = new Map<string, ActionPoint | null>();
  private goals: Candidate[][] = [];
  private goalScores = new Map<string, number>();
  private occupiedCandidates = 0;
  constructor(
    private index: SemanticIndex,
    geometry: SceneGeometry,
    private nav: Navigation,
    private signal?: AbortSignal,
    private traversal?: TraversalPlanner,
    private available: (position: Vec3) => boolean = () => true,
  ) {
    this.surfaces = new SurfacePicker(mapSpace(index.map), false);
    for (const [id, group] of geometry.objects)
      this.surfaces.register(id, group);
  }
  private check() {
    if (this.signal?.aborted) throw new Error("已取消场景构建");
  }
  private point(): ActionPoint {
    return { id: crypto.randomUUID(), name: "", ground: null, height: 0 };
  }
  private length = (a: Vec3, b: Vec3): number | null => {
    this.check();
    const key = pointKey(a) + "/" + pointKey(b);
    if (!this.paths.has(key)) {
      try {
        const ground = this.nav.pathLength(a, b);
        // Candidate ranking only. The chosen connection is strictly checked by route().
        this.paths.set(
          key,
          ground ?? (this.traversal ? distance(a, b) + 10 : null),
        );
      } catch (error) {
        this.check();
        if (!(error instanceof MotionError)) throw error;
        this.paths.set(key, null);
      }
    }
    return this.paths.get(key)!;
  };
  private route(a: Vec3, b: Vec3): Vec3[] | null {
    try {
      return this.traversal
        ? this.traversal
            .route(a, b)
            .flatMap((leg) =>
              leg.kind === "jump"
                ? jumpArc(leg.points[0], leg.points.at(-1)!, leg.arc!)
                : leg.points,
            )
        : this.nav.route(a, b);
    } catch (error) {
      this.check();
      if (
        !(error instanceof MotionError) ||
        !["TARGET_UNREACHABLE", "POINT_NOT_WALKABLE"].includes(error.code)
      )
        throw error;
      this.paths.set(pointKey(a) + "/" + pointKey(b), null);
      return null;
    }
  }
  private anchor(p: Vec3): ActionPoint | null {
    const key = pointKey(p);
    if (this.anchors.has(key)) return this.anchors.get(key)!;
    const hit = this.surfaces
      .vertical(p[0], p[2])
      .filter(
        (h) =>
          Math.abs(h.position[1] - p[1]) <= 0.18 &&
          (h.surface?.normal[1] ?? 0) >=
            Math.cos((this.nav.profile.slope * Math.PI) / 180),
      )
      .sort(
        (a, b) =>
          Math.abs(a.position[1] - p[1]) - Math.abs(b.position[1] - p[1]),
      )[0];
    const point = hit ? pointOnSurface(this.point(), hit) : null;
    if (point) {
      try {
        this.nav.project(pointPosition(point));
      } catch (error) {
        if (!(error instanceof MotionError)) throw error;
        this.anchors.set(key, null);
        return null;
      }
    }
    this.anchors.set(key, point);
    return point;
  }
  private candidates(
    min: Vec3,
    max: Vec3,
    preferred: Vec3,
    keep: (p: Vec3) => boolean = () => true,
    score: (p: Vec3) => number = (p) => distance(p, preferred),
    accept: (p: ActionPoint) => boolean = () => true,
  ): Candidate[] {
    this.check();
    const raw = this.nav
      .candidates(min, max, preferred)
      .filter((p) => {
        if (!keep(p)) return false;
        if (this.available(p)) return true;
        this.occupiedCandidates++;
        return false;
      })
      .sort(
        (a, b) => score(a) - score(b) || pointKey(a).localeCompare(pointKey(b)),
      );
    // Preserve every connected area before adding dense samples from any one area.
    const groups = new Map<number, Vec3[]>();
    for (const p of raw) {
      const id = this.nav.componentAt(p);
      if (!id) continue;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id)!.push(p);
    }
    const ordered: Vec3[] = [];
    for (let i = 0; ordered.length < Math.min(384, raw.length); i++) {
      let added = false;
      for (const group of groups.values())
        if (group[i]) {
          ordered.push(group[i]);
          added = true;
        }
      if (!added) break;
    }
    const out: Candidate[] = [],
      seen = new Set<string>();
    for (const p of ordered) {
      this.check();
      const point = this.anchor(p);
      if (!point || !accept(point)) continue;
      const value = pointPosition(point),
        key = pointKey(value);
      if (!keep(value) || !this.available(value) || seen.has(key)) continue;
      seen.add(key);
      out.push({ position: value, point, score: score(value) });
      if (out.length === 64) break;
    }
    return out;
  }
  private failure(
    code: string,
    message: string,
    candidates: Candidate[] = [],
    closed = false,
  ): never {
    throw Object.assign(new MotionError(code, message), {
      points: candidates.slice(0, 20).map((c) => ({
        ...structuredClone(c.point),
        id: crypto.randomUUID(),
        name: "p" + ++this.count,
      })),
      closed,
    });
  }
  private choose(f: SpatialFeature, candidates: Candidate[]): ActionPoint {
    if (!candidates.length)
      this.failure(
        this.occupiedCandidates
          ? "CHARACTER_SPACE_OCCUPIED"
          : "NO_STANDING_SURFACE",
        this.occupiedCandidates
          ? `${f.semantic.name}的可站立区域没有足够的角色间距；请调整站位或减少该区域人数`
          : `${f.semantic.name}的目标区域内未找到满足角色尺寸、坡度和净空的支撑面${f.semantic.kind === "building" ? "；中央要求仅搜索低处地板，不以屋顶或建筑外替代" : ""}`,
      );
    const ranked = candidates
      .flatMap((c) => {
        const cost = this.from ? this.length(this.from, c.position) : 0;
        return cost === null
          ? []
          : [
              {
                ...c,
                score: c.score + cost * 0.15 + this.goalCost(c.position),
              },
            ];
      })
      .sort((a, b) => a.score - b.score);
    for (const candidate of ranked)
      if (!this.from || this.route(this.from, candidate.position))
        return structuredClone(candidate.point);
    this.failure(
      "TARGET_UNREACHABLE",
      `${f.semantic.name}目标区域存在站位，但从起点无法到达；请检查入口、台阶或水域连接`,
      candidates.slice(0, 1),
    );
  }
  /** Prefer an origin that serves the whole planned action set, not a nearby isolated island. */
  private goalCost(p: Vec3): number {
    const key = pointKey(p);
    if (!this.goalScores.has(key)) {
      let score = 0;
      for (const group of this.goals) {
        if (!group.length) continue; // The target itself will retain its specific diagnostic later.
        const costs = group
          .slice(0, 8)
          .map((c) => this.length(p, c.position))
          .filter((n): n is number => n !== null);
        score += costs.length ? Math.min(...costs) * 0.02 : 10000;
      }
      this.goalScores.set(key, score);
    }
    return this.goalScores.get(key)!;
  }
  private heights(f: SpatialFeature): [number, number] {
    const space = mapSpace(this.index.map);
    return [space.min[1], space.max[1]];
  }
  private nearCandidates(f: SpatialFeature): Candidate[] {
    const [low, high] = this.heights(f),
      c = position(f),
      minGap = this.nav.profile.radius + 0.35,
      maxGap = minGap + 6;
    if (f.semantic.kind === "ground") {
      const preferred =
        this.from ??
        ([0, sampleTerrainHeight(this.index.map, 0, 0), 0] as Vec3);
      return this.candidates(
        [f.min[0], low, f.min[2]],
        [f.max[0], high, f.max[2]],
        preferred,
        (p) =>
          Math.abs(p[1] - sampleTerrainHeight(this.index.map, p[0], p[2])) <=
          Math.max(1.5, this.nav.profile.climb + 0.2),
      );
    }
    const gap = (p: Vec3) =>
      Math.hypot(
        Math.max(f.min[0] - p[0], 0, p[0] - f.max[0]),
        Math.max(f.min[2] - p[2], 0, p[2] - f.max[2]),
      );
    const water = this.index.map.waterBodies.find((w) => w.id === f.waterId),
      boundary = water ? waterBoundaryPoints(water) : null;
    const shoreGap = (p: Vec3) =>
      boundary
        ? Math.min(
            ...boundary.map((a, i) => {
              const b = boundary[(i + 1) % boundary.length],
                dx = b[0] - a[0],
                dz = b[1] - a[1],
                t = Math.max(
                  0,
                  Math.min(
                    1,
                    ((p[0] - a[0]) * dx + (p[2] - a[1]) * dz) /
                      Math.max(1e-9, dx * dx + dz * dz),
                  ),
                );
              return Math.hypot(p[0] - a[0] - t * dx, p[2] - a[1] - t * dz);
            }),
          )
        : gap(p);
    const keep = (p: Vec3) => {
      const d = shoreGap(p);
      return (
        d >= minGap &&
        d <= maxGap &&
        (!water ||
          !isPointInsideWaterBody(water, p[0], p[2], this.index.map)) &&
        Math.abs(p[1] - sampleTerrainHeight(this.index.map, p[0], p[2])) <=
          Math.max(1.5, this.nav.profile.climb + 0.2)
      );
    };
    return this.candidates(
      [f.min[0] - maxGap, low, f.min[2] - maxGap],
      [f.max[0] + maxGap, high, f.max[2] + maxGap],
      c,
      keep,
      (p) =>
        shoreGap(p) +
        (this.from ? distance(p, this.from) * 0.1 : distance(p, c) * 0.01),
    );
  }
  private centerCandidates(f: SpatialFeature): Candidate[] {
    if (!f.objectId)
      this.failure("LOCATION_UNSUPPORTED", "中心查询需要模型表面");
    const c = position(f),
      width = Math.max(0.3, (f.max[0] - f.min[0]) * 0.2),
      depth = Math.max(0.3, (f.max[2] - f.min[2]) * 0.2);
    const base = Math.max(
      f.min[1],
      sampleTerrainHeight(this.index.map, c[0], c[2]),
    );
    const top =
      f.semantic.kind === "building"
        ? Math.min(
            f.max[1] + 0.2,
            base + Math.max(1.5, this.nav.profile.climb + 0.2),
          )
        : f.max[1] + 0.2;
    return this.candidates(
      [
        Math.max(f.min[0], c[0] - width),
        f.min[1] - 0.2,
        Math.max(f.min[2], c[2] - depth),
      ],
      [Math.min(f.max[0], c[0] + width), top, Math.min(f.max[2], c[2] + depth)],
      [c[0], f.min[1], c[2]],
      () => true,
      (p) =>
        Math.hypot(p[0] - c[0], p[2] - c[2]) * 10 +
        Math.max(0, p[1] - f.min[1]),
      (point) =>
        point.surface?.objectId === f.objectId ||
        (f.semantic.kind === "building" &&
          pointPosition(point)[1] <= f.min[1] + this.nav.profile.climb + 0.2),
    );
  }
  private around(x: number, z: number, radius: number): Candidate[] {
    const y = sampleTerrainHeight(this.index.map, x, z),
      preferred: Vec3 = [x, y, z];
    return this.candidates(
      [x - radius, y - 0.35, z - radius],
      [x + radius, y + Math.max(1.5, this.nav.profile.climb + 0.2), z + radius],
      preferred,
      (p) => Math.hypot(p[0] - x, p[2] - z) <= radius + 0.001,
      (p) => distance(p, preferred),
    );
  }
  private sequence(
    layers: Candidate[][],
    closed: boolean,
    dry?: (path: Vec3[]) => boolean,
  ): ActionPoint[] | null {
    const checked = new Map<string, boolean>();
    for (let attempt = 0; attempt < 32; attempt++) {
      const selected = connectedSequence(
        layers.map((l) => l.slice(0, 8).map((c) => c.position)),
        (a, b) => {
          const cost = this.length(a, b);
          if (cost === null) return null;
          if (dry) {
            const key = pointKey(a) + "/" + pointKey(b);
            if (!checked.has(key)) {
              const path = this.route(a, b);
              checked.set(key, !!path && dry(path));
            }
            if (!checked.get(key)) return null;
          }
          return cost;
        },
        {
          from: this.from,
          closed,
          check: () => this.check(),
          entryCost: (p) => this.goalCost(p),
        },
      );
      if (!selected) return null;
      const pairs = selected.slice(1).map((p, i) => [selected[i], p]);
      if (this.from) pairs.push([this.from, selected[0]]);
      if (closed) pairs.push([selected.at(-1)!, selected[0]]);
      if (pairs.some(([a, b]) => !this.route(a, b))) continue;
      return selected.map((p, i) =>
        structuredClone(
          layers[i].find((c) => pointKey(c.position) === pointKey(p))!.point,
        ),
      );
    }
    this.failure(
      "REGION_SEARCH_LIMIT",
      "候选路线检查达到上限，请调整路径点后重新检查",
    );
  }
  private circumference(f: SpatialFeature): ActionPoint[] {
    const water = this.index.map.waterBodies.find((w) => w.id === f.waterId)!;
    const boundary = waterBoundaryPoints(water);
    let hull = convexBoundary(boundary);
    if (hull.length > 10)
      hull = [
        [f.min[0], f.min[2]],
        [f.max[0], f.min[2]],
        [f.max[0], f.max[2]],
        [f.min[0], f.max[2]],
      ];
    if (hull.length < 3)
      this.failure(
        "LOCATION_UNSUPPORTED",
        `${f.semantic.name}没有有效水岸轮廓`,
      );
    const dry = (p: Vec3) =>
      !isPointInsideWaterBody(water, p[0], p[2], this.index.map);
    let suggestion: Candidate[] = [];
    for (const extra of [1, 2, 3.5, 5]) {
      this.check();
      const margin = this.nav.profile.radius + extra;
      let ideals = offsetBoundary(hull, margin);
      if (this.from) {
        const start = ideals.reduce(
          (best, p, i) =>
            Math.hypot(p[0] - this.from![0], p[1] - this.from![2]) <
            Math.hypot(
              ideals[best][0] - this.from![0],
              ideals[best][1] - this.from![2],
            )
              ? i
              : best,
          0,
        );
        ideals = [...ideals.slice(start), ...ideals.slice(0, start)];
      }
      const layers = ideals.map(([x, z]) =>
        this.around(x, z, Math.min(2, margin * 0.5)).filter((c) =>
          dry(c.position),
        ),
      );
      suggestion = layers.map(
        (layer, i) => layer[0] ?? this.suggestion(ideals[i][0], ideals[i][1]),
      );
      const points = this.sequence(
        layers,
        true,
        (path) =>
          path.every(dry) &&
          path.slice(1).every((p, i) => !crossesBoundary(path[i], p, boundary)),
      );
      if (!points) continue;
      const trajectory = points.flatMap((p, i) =>
        this.nav.route(
          pointPosition(p),
          pointPosition(points[(i + 1) % points.length]),
        ),
      );
      if (
        boundary.every(
          ([x, z]) =>
            Math.abs(winding(trajectory, [x, water.level, z])) >= Math.PI * 1.9,
        )
      )
        return points;
    }
    this.failure(
      "CIRCUIT_UNREACHABLE",
      `${f.semantic.name}外围未找到完整环绕、连通且不穿过水域的路线`,
      suggestion,
      true,
    );
  }
  private guide(f: SpatialFeature): ActionPoint[] {
    const guide = this.index.map.guides.find((g) => g.id === f.guideId)!;
    const simplified = guide.points.filter((p, i, all) => {
      if (i === 0 || i === all.length - 1) return true;
      const a = all[i - 1],
        b = all[i + 1],
        length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      return (
        length < 1e-6 ||
        Math.abs(
          (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0]),
        ) /
          length >
          0.2
      );
    });
    if (simplified.length > 20)
      this.failure("REGION_SEARCH_LIMIT", "引导线转折过多，请分段制作路线");
    const layers = simplified.map(([x, z]) => this.around(x, z, 0.65));
    const result = this.sequence(layers, guide.closed);
    if (!result)
      this.failure(
        layers.some((l) => !l.length)
          ? "NO_STANDING_SURFACE"
          : "TARGET_UNREACHABLE",
        `${f.semantic.name}在有限吸附范围内没有连续可通行路线；请检查支撑面与入口连接`,
        layers.map(
          (layer, i) =>
            layer[0] ?? this.suggestion(simplified[i][0], simplified[i][1]),
        ),
        guide.closed,
      );
    return result;
  }
  private suggestion(x: number, z: number): Candidate {
    const position: Vec3 = [x, sampleTerrainHeight(this.index.map, x, z), z];
    return { position, point: { ...this.point(), ground: position }, score: 0 };
  }
  async resolve(
    intent: LocationIntent,
    from?: Vec3,
    destinations: LocationIntent[] = [],
  ): Promise<ResolvedLocation> {
    // Allow progress rendering and cancellation between bounded region queries.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    this.from = from;
    this.occupiedCandidates = 0;
    this.check();
    const f = this.index.features.get(intent.featureId);
    if (!f || !f.semantic.queries.includes(intent.relation))
      this.failure("LOCATION_UNSUPPORTED", "未知地图地点或位置查询");
    this.goals = [];
    this.goalScores.clear();
    if (!from)
      for (const target of destinations) {
        const feature = this.index.features.get(target.featureId);
        if (!feature || target.relation === "facing") continue;
        // Preview only the destination region here; its full query is independently checked below.
        if (target.relation === "center")
          this.goals.push(this.centerCandidates(feature));
        else if (target.relation === "alongGuide") {
          const first = this.index.map.guides.find(
            (g) => g.id === feature.guideId,
          )?.points[0];
          if (first) this.goals.push(this.around(first[0], first[1], 0.65));
        } else this.goals.push(this.nearCandidates(feature));
      }
    let points: ActionPoint[],
      closed = false;
    if (intent.relation === "facing") {
      let target = position(f);
      if (f.waterId) {
        const water = this.index.map.waterBodies.find(
          (w) => w.id === f.waterId,
        )!;
        const bridges = [...this.index.features.values()].filter(
          (x) => x.semantic.kind === "bridge",
        );
        for (const [u, v] of [
          [0, 0],
          [0, 0.25],
          [0, -0.25],
          [0.25, 0],
          [-0.25, 0],
        ]) {
          const p: Vec3 = [
            target[0] + u * (f.max[0] - f.min[0]),
            target[1],
            target[2] + v * (f.max[2] - f.min[2]),
          ];
          if (
            isPointInsideWaterBody(water, p[0], p[2], this.index.map) &&
            !bridges.some(
              (b) =>
                p[0] >= b.min[0] &&
                p[0] <= b.max[0] &&
                p[2] >= b.min[2] &&
                p[2] <= b.max[2],
            )
          ) {
            target = p;
            break;
          }
        }
      }
      points = [{ ...this.point(), ground: target }];
    } else if (intent.relation === "center")
      points = [this.choose(f, this.centerCandidates(f))];
    else if (intent.relation === "surroundingRoute") {
      points = this.circumference(f);
      closed = true;
    } else if (intent.relation === "alongGuide") {
      points = this.guide(f);
      closed = this.index.map.guides.find((g) => g.id === f.guideId)!.closed;
    } else points = [this.choose(f, this.nearCandidates(f))];
    points = points.map((p) => ({
      ...p,
      id: crypto.randomUUID(),
      name: "p" + ++this.count,
    }));
    return { intent: structuredClone(intent), points, closed };
  }
  /** Editable suggestions survive failed validation. They are never silently executable. */
  preview(intent: LocationIntent): ResolvedLocation {
    const f = this.index.features.get(intent.featureId);
    const closed =
      intent.relation === "surroundingRoute" ||
      !!this.index.map.guides.find((g) => g.id === f?.guideId)?.closed;
    const guide = this.index.map.guides.find((g) => g.id === f?.guideId);
    const raw: (Vec3 | null)[] =
      guide && intent.relation === "alongGuide"
        ? guide.points
            .slice(0, 20)
            .map(([x, z]) => [x, sampleTerrainHeight(this.index.map, x, z), z])
        : [f ? position(f) : null];
    return {
      intent,
      closed,
      points: raw.map((p) => ({
        ...this.point(),
        name: "p" + ++this.count,
        ground: p,
      })),
    };
  }
  validate(location: ResolvedLocation): void {
    if (!location.points.length || location.points.some((p) => !p.ground))
      throw new Error("请放置这个地点的标点");
    if (location.intent.relation === "facing") return;
    for (const p of location.points) {
      if (!this.available(pointPosition(p)))
        throw new MotionError(
          "CHARACTER_SPACE_OCCUPIED",
          "该站位与其他角色重叠，请调整标点并保留角色间距",
        );
      if (this.traversal) this.traversal.assertStationary(pointPosition(p));
      else this.nav.project(pointPosition(p));
    }
    for (let i = 1; i < location.points.length; i++)
      if (
        !this.route(
          pointPosition(location.points[i - 1]),
          pointPosition(location.points[i]),
        )
      )
        throw new Error("地点的途经点之间不可达");
    if (location.closed)
      if (
        !this.route(
          pointPosition(location.points.at(-1)!),
          pointPosition(location.points[0]),
        )
      )
        throw new Error("闭合路线不能返回起点");
  }
}
