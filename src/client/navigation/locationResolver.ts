import * as THREE from "three";
import {
  pointPosition,
  type ActionPoint,
  type Vec3,
} from "../../shared/motion";
import type { LocationIntent } from "../../shared/mapSemantics";
import { SurfacePicker, pointOnSurface } from "../rendering/surfacePicker";
import { mapSpace } from "../../shared/sceneMotion";
import { sampleTerrainHeight } from "../rendering/map/shared/map";
import { isPointInsideWaterBody } from "../rendering/map/shared/mapWater";
import type { SemanticIndex, SpatialFeature } from "./semanticIndex";
import type { SceneGeometry } from "./geometry";
import type { Navigation } from "./navigation";

export interface ResolvedLocation {
  intent: LocationIntent;
  points: ActionPoint[];
  closed: boolean;
}
const position = (f: SpatialFeature): Vec3 =>
  f.min.map((v, i) => (v + f.max[i]) / 2) as Vec3;
/** Semantic queries are resolved against local geometry and the actual actor profile. */
export class LocationResolver {
  private terrain: SurfacePicker;
  private count = 0;
  constructor(
    private index: SemanticIndex,
    private geometry: SceneGeometry,
    private nav: Navigation,
    private signal?: AbortSignal,
  ) {
    this.terrain = new SurfacePicker(mapSpace(index.map), false);
    this.terrain.register("terrain", geometry.objects.get("terrain")!);
  }
  private check() {
    if (this.signal?.aborted) throw new Error("已取消场景构建");
  }
  private point(): ActionPoint {
    return {
      id: crypto.randomUUID(),
      name: "p" + ++this.count,
      ground: null,
      height: 0,
    };
  }
  private standing(x: number, z: number): ActionPoint {
    this.check();
    const y = sampleTerrainHeight(this.index.map, x, z);
    const projected = this.nav.project([x, y, z]);
    // Ground queries deliberately ignore roofs, tree crowns and water surfaces.
    const hit = this.terrain.pick(
      new THREE.Raycaster(
        new THREE.Vector3(projected[0], y + 2, projected[2]),
        new THREE.Vector3(0, -1, 0),
      ),
    );
    if (!hit) throw new Error("此处没有地面支撑");
    return pointOnSurface(this.point(), hit);
  }
  private near(f: SpatialFeature): ActionPoint {
    if (f.semantic.kind === "ground") {
      for (const [x, z] of [
        [0, 0],
        [5, 0],
        [-5, 0],
        [0, 5],
        [0, -5],
        [10, 10],
        [-10, -10],
      ])
        try {
          return this.standing(x, z);
        } catch {
          this.check();
        }
      throw new Error("地图中央附近没有适合该角色的地面站位");
    }
    const margin = this.nav.profile.radius + 0.8;
    for (const extra of [0, 1.5, 3, 5]) {
      const d = margin + extra,
        c = position(f);
      const candidates = [
        [c[0], f.min[2] - d],
        [f.max[0] + d, c[2]],
        [c[0], f.max[2] + d],
        [f.min[0] - d, c[2]],
      ];
      for (const [x, z] of candidates)
        try {
          return this.standing(x, z);
        } catch {
          this.check();
        }
    }
    throw new Error(`${f.semantic.name}附近没有适合该角色的地面站位`);
  }
  private center(f: SpatialFeature): ActionPoint {
    const group = f.objectId ? this.geometry.objects.get(f.objectId) : null;
    if (!group) throw new Error("中心查询需要模型表面");
    const picker = new SurfacePicker(mapSpace(this.index.map), false);
    picker.register(f.objectId!, group);
    const c = position(f),
      width = f.max[0] - f.min[0],
      depth = f.max[2] - f.min[2];
    for (const [u, v] of [
      [0, 0],
      [-0.1, 0],
      [0.1, 0],
      [0, -0.1],
      [0, 0.1],
    ]) {
      this.check();
      const hit = picker.pick(
        new THREE.Raycaster(
          new THREE.Vector3(c[0] + u * width, f.max[1] + 1, c[2] + v * depth),
          new THREE.Vector3(0, -1, 0),
        ),
      );
      if (
        !hit ||
        (hit.surface?.normal[1] ?? 0) <
          Math.cos((this.nav.profile.slope * Math.PI) / 180)
      )
        continue;
      try {
        this.nav.project(hit.position);
        return pointOnSurface(this.point(), hit);
      } catch {
        this.check();
      }
    }
    throw new Error(`${f.semantic.name}中央没有符合角色通行能力的支撑表面`);
  }
  private circumference(f: SpatialFeature): ActionPoint[] {
    const water = this.index.map.waterBodies.find((w) => w.id === f.waterId)!;
    for (const margin of [
      this.nav.profile.radius + 3,
      this.nav.profile.radius + 5,
      this.nav.profile.radius + 7,
      this.nav.profile.radius + 9,
    ]) {
      this.check();
      const corners = [
        [f.max[0] + margin, f.min[2] - margin],
        [f.max[0] + margin, f.max[2] + margin],
        [f.min[0] - margin, f.max[2] + margin],
        [f.min[0] - margin, f.min[2] - margin],
      ];
      try {
        const points = corners.map(([x, z]) => this.standing(x, z)),
          trajectory: Vec3[] = [];
        for (let i = 0; i < points.length; i++)
          trajectory.push(
            ...this.nav.route(
              pointPosition(points[i]),
              pointPosition(points[(i + 1) % points.length]),
            ),
          );
        if (
          trajectory.some((p) =>
            isPointInsideWaterBody(water, p[0], p[2], this.index.map),
          )
        )
          continue;
        const center = position(f);
        let winding = 0;
        for (let i = 1; i < trajectory.length; i++) {
          const a = trajectory[i - 1],
            b = trajectory[i];
          winding += Math.atan2(
            (a[0] - center[0]) * (b[2] - center[2]) -
              (a[2] - center[2]) * (b[0] - center[0]),
            (a[0] - center[0]) * (b[0] - center[0]) +
              (a[2] - center[2]) * (b[2] - center[2]),
          );
        }
        if (Math.abs(winding) < Math.PI * 1.9) continue;
        return points;
      } catch {
        this.check();
      }
    }
    throw new Error(`${f.semantic.name}外围没有完整且不穿过水域的巡游路线`);
  }
  async resolve(intent: LocationIntent): Promise<ResolvedLocation> {
    this.check();
    const f = this.index.features.get(intent.featureId);
    if (!f || !f.semantic.queries.includes(intent.relation))
      throw new Error("未知地图地点或位置查询");
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
    } else if (intent.relation === "center") points = [this.center(f)];
    else if (intent.relation === "surroundingRoute") {
      points = this.circumference(f);
      closed = true;
    } else if (intent.relation === "alongGuide") {
      const guide = this.index.map.guides.find((g) => g.id === f.guideId)!;
      const simplified = guide.points.filter(
        (_, i) =>
          i === 0 ||
          i === guide.points.length - 1 ||
          i % Math.ceil(guide.points.length / 6) === 0,
      );
      points = simplified.map(([x, z]) => this.standing(x, z));
      closed = guide.closed;
      for (let i = 1; i < points.length; i++)
        this.nav.route(pointPosition(points[i - 1]), pointPosition(points[i]));
      if (closed)
        this.nav.route(pointPosition(points.at(-1)!), pointPosition(points[0]));
    } else points = [this.near(f)];
    // Failed candidate attempts must not consume visible p numbers.
    return { intent: structuredClone(intent), points, closed };
  }
}
