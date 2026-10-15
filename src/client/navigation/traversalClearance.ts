import * as THREE from "three";
import type { SceneGeometry } from "./geometry";
import type { EditableMap } from "../../shared/maps";
import type { NavigationProfile } from "../../shared/sceneMotion";
import type { Vec3 } from "../../shared/motion";
import { isPointInsidePlayableArea } from "../rendering/map/shared/mapLayout";
import { TriangleIndex } from "./triangleIndex";

/** Sampled cylinder sweeps against actual triangles, independent of render batching. */
export class TraversalClearance {
  private triangles: TriangleIndex;
  private offsets: [number, number][];
  constructor(
    geometry: SceneGeometry,
    private map: EditableMap,
    private profile: NavigationProfile,
  ) {
    this.triangles = TriangleIndex.for(geometry);
    this.offsets = [
      [0, 0],
      ...Array.from({ length: 8 }, (_, i): [number, number] => [
        Math.cos((i * Math.PI) / 4) * profile.radius,
        Math.sin((i * Math.PI) / 4) * profile.radius,
      ]),
    ];
  }
  private hit(a: Vec3, b: Vec3) {
    return this.triangles.hit(new THREE.Vector3(...a), new THREE.Vector3(...b));
  }
  clearPoint(p: Vec3): boolean {
    const h = this.profile.height;
    for (const [x, z] of this.offsets) {
      const q: Vec3 = [p[0] + x, p[1] + 0.04, p[2] + z];
      if (
        !isPointInsidePlayableArea(
          this.map.layout,
          this.map.box.size,
          q[0],
          q[2],
        ) ||
        p[1] < -this.map.box.size[1] ||
        p[1] + h > Math.max(100, this.map.box.size[1] * 4)
      )
        return false;
      if (this.hit(q, [q[0], p[1] + h - 0.02, q[2]])) return false;
    }
    // Detect a cylinder entirely inside a closed solid (surface-only sweeps miss this).
    const center: Vec3 = [p[0], p[1] + h / 2, p[2]];
    const exit = this.hit(center, [
      this.map.box.size[0] * 2,
      center[1] + 0.001,
      center[2] + 0.001,
    ]);
    if (exit) {
      const normal = exit.normal;
      const direction = new THREE.Vector3(
        this.map.box.size[0] * 2 - center[0],
        0.001,
        0.001,
      );
      if (normal.dot(direction) > 1e-5) return false;
    }
    return true;
  }
  clearPath(points: Vec3[]): boolean {
    for (let i = 0; i < points.length; i++) {
      if (!this.clearPoint(points[i])) return false;
      if (!i) continue;
      const a = points[i - 1],
        b = points[i];
      for (const [x, z] of this.offsets)
        for (const y of [
          0.04,
          this.profile.height / 2,
          this.profile.height - 0.02,
        ])
          if (
            this.hit(
              [a[0] + x, a[1] + y, a[2] + z],
              [b[0] + x, b[1] + y, b[2] + z],
            )
          )
            return false;
    }
    return true;
  }
  dispose() {
    /* The index is CPU data weakly owned by the geometry snapshot. */
  }
}
