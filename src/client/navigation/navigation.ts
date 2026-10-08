import {
  init,
  importNavMesh,
  NavMeshQuery,
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
  }
}
