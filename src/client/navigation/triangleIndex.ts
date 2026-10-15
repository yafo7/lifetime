import * as THREE from "three";
import type { SceneGeometry } from "./geometry";

const cached = new WeakMap<SceneGeometry, TriangleIndex>();
/** CPU-only XZ broad phase shared by jump, flight and stationary probes. */
export class TriangleIndex {
  private cells = new Map<
    string,
    { triangle: THREE.Triangle; box: THREE.Box3 }[]
  >();
  private cellSize = 2;
  static for(geometry: SceneGeometry) {
    let index = cached.get(geometry);
    if (!index) {
      index = new TriangleIndex(geometry);
      cached.set(geometry, index);
    }
    return index;
  }
  private constructor(geometry: SceneGeometry) {
    geometry.root.updateMatrixWorld(true);
    geometry.root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const position = mesh.geometry.getAttribute("position"),
        indices = mesh.geometry.index;
      if (!position) return;
      for (let i = 0; i < (indices?.count ?? position.count); i += 3) {
        const vertices = [0, 1, 2].map((j) =>
          new THREE.Vector3()
            .fromBufferAttribute(
              position,
              indices ? indices.getX(i + j) : i + j,
            )
            .applyMatrix4(mesh.matrixWorld),
        );
        const triangle = new THREE.Triangle(
          ...(vertices as [THREE.Vector3, THREE.Vector3, THREE.Vector3]),
        );
        const box = new THREE.Box3().setFromPoints(vertices);
        const entry = { triangle, box };
        for (
          let x = Math.floor(box.min.x / this.cellSize);
          x <= Math.floor(box.max.x / this.cellSize);
          x++
        )
          for (
            let z = Math.floor(box.min.z / this.cellSize);
            z <= Math.floor(box.max.z / this.cellSize);
            z++
          ) {
            const key = `${x},${z}`;
            let cell = this.cells.get(key);
            if (!cell) {
              cell = [];
              this.cells.set(key, cell);
            }
            cell.push(entry);
          }
      }
    });
  }
  hit(
    start: THREE.Vector3,
    end: THREE.Vector3,
  ): { normal: THREE.Vector3; distance: number } | undefined {
    const direction = end.clone().sub(start),
      length = direction.length();
    if (length < 0.016) return;
    const ray = new THREE.Ray(start, direction.multiplyScalar(1 / length));
    const box = new THREE.Box3()
      .setFromPoints([start, end])
      .expandByScalar(0.001);
    const seen = new Set<THREE.Triangle>(),
      point = new THREE.Vector3();
    let nearest: { normal: THREE.Vector3; distance: number } | undefined;
    for (
      let x = Math.floor(box.min.x / this.cellSize);
      x <= Math.floor(box.max.x / this.cellSize);
      x++
    )
      for (
        let z = Math.floor(box.min.z / this.cellSize);
        z <= Math.floor(box.max.z / this.cellSize);
        z++
      )
        for (const entry of this.cells.get(`${x},${z}`) ?? []) {
          if (seen.has(entry.triangle) || !entry.box.intersectsBox(box))
            continue;
          seen.add(entry.triangle);
          const { a, b, c } = entry.triangle;
          if (!ray.intersectTriangle(a, b, c, false, point)) continue;
          const distance = point.distanceTo(start);
          if (
            distance <= 0.008 ||
            distance >= length - 0.008 ||
            (nearest && distance >= nearest.distance)
          )
            continue;
          nearest = {
            normal: entry.triangle.getNormal(new THREE.Vector3()),
            distance,
          };
        }
    return nearest;
  }
}
