import {
  init,
  importNavMesh,
  NavMeshQuery,
  Detour,
  statusDetail,
  type NavMesh,
} from "recast-navigation";
import { generateSoloNavMesh } from "recast-navigation/generators";
import type { NavigationProfile } from "../../shared/sceneMotion";
import { MotionError, type Vec3 } from "../../shared/motion";
import type { SceneGeometry } from "./geometry";
import { navigationConfig } from "./settings";
const xyz = (p: Vec3) => ({ x: p[0], y: p[1], z: p[2] }),
  tuple = (p: { x: number; y: number; z: number }): Vec3 => [p.x, p.y, p.z];
export class Navigation {
  private worker: Worker | null = null;
  private pendingReject: ((e: Error) => void) | null = null;
  private disposed = false;
  private query: NavMeshQuery | null = null;
  private mesh: NavMesh | null = null;
  private components = new Map<number, number>();
  constructor(readonly profile: NavigationProfile) {}
  async build(
    geometry: Pick<SceneGeometry, "positions" | "indices">,
  ): Promise<void> {
    await init();
    if (this.disposed) throw new Error("导航已取消");
    if (typeof Worker === "undefined") {
      const result = generateSoloNavMesh(
        geometry.positions,
        geometry.indices,
        navigationConfig(this.profile),
      );
      if (!result.success) throw new Error(result.error);
      this.mesh = result.navMesh;
    } else {
      const bytes = await new Promise<Uint8Array>((resolve, reject) => {
        this.pendingReject = reject;
        const worker = (this.worker = new Worker(
          new URL("./navigation.worker.ts", import.meta.url),
          { type: "module" },
        ));
        worker.onmessage = (e) => {
          e.data.error
            ? reject(new Error(e.data.error))
            : resolve(e.data.bytes);
        };
        worker.onerror = (e) => reject(new Error(e.message));
        worker.postMessage({
          positions: geometry.positions,
          indices: geometry.indices,
          profile: this.profile,
        });
      }).finally(() => {
        this.worker?.terminate();
        this.worker = null;
        this.pendingReject = null;
      });
      if (this.disposed) throw new Error("导航已取消");
      this.mesh = importNavMesh(bytes).navMesh;
    }
    this.query = new NavMeshQuery(this.mesh);
    this.components.clear();
  }
  project(p: Vec3, tolerance = 0.35): Vec3 {
    if (!this.query) throw new MotionError("NAV_NOT_READY", "导航尚未准备好");
    const r = this.query.findClosestPoint(xyz(p), {
      halfExtents: { x: tolerance, y: 0.35, z: tolerance },
    });
    if (
      !r.success ||
      Math.hypot(r.point.x - p[0], r.point.z - p[2]) > tolerance ||
      Math.abs(r.point.y - p[1]) > 0.35
    )
      throw new MotionError(
        "POINT_NOT_WALKABLE",
        "该点没有可行走表面，请选择地面或可通行桥面",
      );
    return tuple(r.point);
  }
  /** Bounded spawn search; never falls back to a random polygon or another distant floor. */
  nearest(p: Vec3, horizontal = 2, vertical = 0.5): Vec3 | null {
    if (!this.query) throw new MotionError("NAV_NOT_READY", "导航尚未准备好");
    const hit = this.query.findClosestPoint(xyz(p), {
      halfExtents: { x: horizontal, y: vertical, z: horizontal },
    });
    return hit.success &&
      hit.polyRef &&
      Math.hypot(hit.point.x - p[0], hit.point.z - p[2]) <= horizontal &&
      Math.abs(hit.point.y - p[1]) <= vertical
      ? tuple(hit.point)
      : null;
  }
  /** Deterministic samples on every overlapping floor, including narrow polygons.
   * These are candidates only: callers must enforce semantic bounds and connectivity.
   * No random fallback and no projection to a different floor.
   */
  candidates(min: Vec3, max: Vec3, preferred: Vec3): Vec3[] {
    if (!this.query || !this.mesh)
      throw new MotionError("NAV_NOT_READY", "导航尚未准备好");
    const center = min.map((v, i) => (v + max[i]) / 2) as Vec3;
    const half = max.map((v, i) => Math.max(0.01, (v - min[i]) / 2)) as Vec3;
    const result = this.query.queryPolygons(xyz(center), xyz(half), {
      maxPolys: 8192,
    });
    if (
      !result.success ||
      statusDetail(result.status, Detour.DT_BUFFER_TOO_SMALL)
    )
      throw new MotionError(
        "REGION_SEARCH_LIMIT",
        "位置区域过大，请缩小目标区域后重试",
      );
    const points = new Map<string, Vec3>();
    // Bound lattice work on large maps; polygon representatives preserve thin passages.
    const spacing = Math.max(
      0.6,
      Math.sqrt(((max[0] - min[0]) * (max[2] - min[2])) / 1600),
    );
    for (const ref of result.polyRefs) {
      const { success, tile, poly } = this.mesh.getTileAndPolyByRef(ref);
      if (!success || poly.getType() !== 0) continue;
      const vertices = Array.from({ length: poly.vertCount() }, (_, i) => {
        const index = poly.verts(i) * 3;
        return [
          tile.verts(index),
          tile.verts(index + 1),
          tile.verts(index + 2),
        ] as Vec3;
      });
      const c = vertices.reduce(
        (a, p) => a.map((v, i) => v + p[i] / vertices.length) as Vec3,
        [0, 0, 0] as Vec3,
      );
      const add = (p: Vec3) => {
        const hit = this.query!.closestPointOnPoly(ref, xyz(p));
        if (!hit.success) return;
        const value = tuple(hit.closestPoint);
        if (value.some((v, i) => v < min[i] - 0.001 || v > max[i] + 0.001))
          return;
        points.set(value.map((v) => Math.round(v * 1000)).join(","), value);
      };
      add(preferred);
      add(c);
      for (const p of vertices)
        add(p.map((v, i) => v * 0.85 + c[i] * 0.15) as Vec3);
      const x0 = Math.max(min[0], Math.min(...vertices.map((p) => p[0]))),
        x1 = Math.min(max[0], Math.max(...vertices.map((p) => p[0]))),
        z0 = Math.max(min[2], Math.min(...vertices.map((p) => p[2]))),
        z1 = Math.min(max[2], Math.max(...vertices.map((p) => p[2])));
      for (let x = x0 + spacing / 2; x < x1; x += spacing)
        for (let z = z0 + spacing / 2; z < z1; z += spacing) add([x, c[1], z]);
    }
    return [...points.values()];
  }
  /** Full-corridor cost for candidate scoring; route() supplies execution heights. */
  componentAt(p: Vec3): number {
    if (!this.query || !this.mesh)
      throw new MotionError("NAV_NOT_READY", "导航尚未准备好");
    const start = this.query.findClosestPoint(xyz(p), {
      halfExtents: { x: 0.05, y: 0.35, z: 0.05 },
    });
    if (!start.success || !start.polyRef) return 0;
    return this.component(start.polyRef);
  }
  /** Static ground-polygon connectivity. No off-mesh links or dynamic obstacles. */
  private component(start: number): number {
    if (this.components.has(start)) return this.components.get(start)!;
    const queue = [start];
    this.components.set(start, start);
    for (let i = 0; i < queue.length; i++) {
      const { success, tile, poly } = this.mesh!.getTileAndPolyByRef(queue[i]);
      if (!success) continue;
      for (let index = poly.firstLink(); index !== Detour.DT_NULL_LINK;) {
        const link = tile.links(index),
          ref = link.ref();
        index = link.next();
        if (!ref || this.components.has(ref)) continue;
        const neighbor = this.mesh!.getTileAndPolyByRef(ref);
        if (!neighbor.success || neighbor.poly.getType() !== 0) continue;
        this.components.set(ref, start);
        queue.push(ref);
      }
    }
    return start;
  }
  pathLength(from: Vec3, to: Vec3): number | null {
    if (!this.query) throw new MotionError("NAV_NOT_READY", "导航尚未准备好");
    const a = this.nearest(from, 0.35, 0.35),
      b = this.nearest(to, 0.35, 0.35);
    if (!a || !b) return null;
    const start = this.query.findClosestPoint(xyz(a), {
        halfExtents: { x: 0.01, y: 0.1, z: 0.01 },
      }),
      end = this.query.findClosestPoint(xyz(b), {
        halfExtents: { x: 0.01, y: 0.1, z: 0.01 },
      });
    if (!start.success || !end.success || !start.polyRef || !end.polyRef)
      return null;
    if (this.component(start.polyRef) !== this.component(end.polyRef))
      return null;
    const corridor = this.query.findPath(
      start.polyRef,
      end.polyRef,
      xyz(a),
      xyz(b),
      { maxPathPolys: 4096 },
    );
    let straight: ReturnType<NavMeshQuery["findStraightPath"]> | undefined;
    try {
      if (
        !corridor.success ||
        !corridor.polys.size ||
        corridor.polys.get(corridor.polys.size - 1) !== end.polyRef
      )
        return null;
      straight = this.query.findStraightPath(xyz(a), xyz(b), corridor.polys, {
        maxStraightPathPoints: 4096,
      });
      if (!straight.success || !straight.straightPathCount) return null;
      let length = 0,
        previous = a;
      for (let i = 0; i < straight.straightPathCount; i++) {
        const p: Vec3 = [
          straight.straightPath.get(i * 3),
          straight.straightPath.get(i * 3 + 1),
          straight.straightPath.get(i * 3 + 2),
        ];
        length += Math.hypot(...p.map((v, j) => v - previous[j]));
        previous = p;
      }
      return Math.hypot(...previous.map((v, i) => v - b[i])) <= 0.1
        ? length
        : null;
    } finally {
      corridor.polys.destroy();
      straight?.straightPath.destroy();
      straight?.straightPathFlags.destroy();
      straight?.straightPathRefs.destroy();
    }
  }
  /** Small manual movement stays in connected polygons and slides along their walls. */
  move(from: Vec3, to: Vec3): Vec3 {
    if (!this.query) throw new MotionError("NAV_NOT_READY", "导航尚未准备好");
    const start = this.query.findClosestPoint(xyz(from), {
      halfExtents: { x: 0.2, y: 0.35, z: 0.2 },
    });
    if (!start.success || !start.polyRef) return [...from];
    const moved = this.query.moveAlongSurface(
      start.polyRef,
      start.point,
      xyz(to),
      { maxVisitedSize: 32 },
    );
    if (!moved.success || !moved.visited.length) return [...from];
    const ref = moved.visited.at(-1)!;
    const height = this.query.getPolyHeight(ref, moved.resultPosition);
    if (height.success)
      return [moved.resultPosition.x, height.height, moved.resultPosition.z];
    // Float rounding at a polygon edge can make getPolyHeight reject the wall-sliding point.
    // Clamp only to the visited polygon, never a nearby disconnected surface.
    const edge = this.query.closestPointOnPoly(ref, moved.resultPosition);
    if (
      edge.success &&
      Math.hypot(
        edge.closestPoint.x - moved.resultPosition.x,
        edge.closestPoint.z - moved.resultPosition.z,
      ) < 0.001
    )
      return tuple(edge.closestPoint);
    return [...from];
  }
  route(from: Vec3, to: Vec3, via: Vec3[] = []): Vec3[] {
    const targets = [from, ...via, to].map((p) => this.project(p)),
      out: Vec3[] = [];
    for (let i = 1; i < targets.length; i++) {
      const query = this.query!,
        a = xyz(targets[i - 1]),
        b = xyz(targets[i]),
        options = { halfExtents: { x: 0.35, y: 0.35, z: 0.35 } };
      const start = query.findClosestPoint(a, options),
        end = query.findClosestPoint(b, options);
      const corridor = query.findPath(start.polyRef, end.polyRef, a, b, {
        maxPathPolys: 4096,
      });
      let straight: ReturnType<NavMeshQuery["findStraightPath"]> | null = null;
      try {
        if (
          !corridor.success ||
          !corridor.polys.size ||
          corridor.polys.get(corridor.polys.size - 1) !== end.polyRef
        )
          throw new MotionError(
            "TARGET_UNREACHABLE",
            `第 ${i} 段路线不可达，可能被障碍或水域隔开`,
          );
        straight = query.findStraightPath(a, b, corridor.polys, {
          maxStraightPathPoints: 4096,
          straightPathOptions: 2,
        });
        const raw: Vec3[] = Array.from(
          { length: straight.straightPathCount },
          (_, j) => [
            straight!.straightPath.get(j * 3),
            straight!.straightPath.get(j * 3 + 1),
            straight!.straightPath.get(j * 3 + 2),
          ],
        );
        if (
          !straight.success ||
          !raw.length ||
          Math.hypot(...raw.at(-1)!.map((v, j) => v - targets[i][j])) > 0.1
        )
          throw new MotionError("TARGET_UNREACHABLE", "路线未能完整到达目标");
        // Every polygon crossing is retained; sample the detail mesh of that corridor,
        // rather than projecting a flat shortcut onto arbitrary nearby floors.
        for (let j = 1; j < raw.length; j++) {
          const a = raw[j - 1],
            b = raw[j],
            n = Math.max(
              1,
              Math.ceil(Math.hypot(...b.map((v, k) => v - a[k])) / 0.2),
            ),
            ref = straight.straightPathRefs.get(j - 1) || start.polyRef;
          if (!out.length) out.push(a);
          for (let k = 1; k <= n; k++) {
            const u = k / n,
              p = a.map((v, l) => v + (b[l] - v) * u) as Vec3,
              height = query.getPolyHeight(ref, xyz(p));
            if (height.success) p[1] = height.height;
            else {
              // Boundary rounding can put a crossing just outside its polygon.
              // Search only the proven corridor, never another overlapping floor.
              let support: Vec3 | null = null;
              for (let index = 0; index < corridor.polys.size; index++) {
                const hit = query.closestPointOnPoly(
                  corridor.polys.get(index),
                  xyz(p),
                );
                if (
                  !hit.success ||
                  Math.hypot(
                    hit.closestPoint.x - p[0],
                    hit.closestPoint.z - p[2],
                  ) > 0.001
                )
                  continue;
                const candidate = tuple(hit.closestPoint);
                if (
                  !support ||
                  Math.abs(candidate[1] - p[1]) < Math.abs(support[1] - p[1])
                )
                  support = candidate;
              }
              if (!support)
                throw new MotionError(
                  "TARGET_UNREACHABLE",
                  "路线缺少连续的可行走表面",
                );
              p[1] = support[1];
            }
            out.push(p);
          }
        }
        if (raw.length === 1) {
          if (!out.length) out.push(targets[i - 1]);
          out.push(targets[i]);
        }
      } finally {
        corridor.polys.destroy();
        straight?.straightPath.destroy();
        straight?.straightPathFlags.destroy();
        straight?.straightPathRefs.destroy();
      }
    }
    return out.length >= 2 ? out : [targets[0], targets.at(-1)!];
  }
  dispose() {
    this.disposed = true;
    this.pendingReject?.(new Error("导航已取消"));
    this.worker?.terminate();
    this.query?.destroy();
    this.mesh?.destroy();
    this.query = null;
    this.mesh = null;
    this.components.clear();
  }
}
