import * as THREE from "three";
import {
  checkPoint,
  MotionError,
  pointPosition,
  type ActionPoint,
  type SurfaceAnchor,
  type Vec3,
  type MotionSpace,
} from "../../shared/motion";

export interface SurfaceHit {
  position: Vec3;
  surface?: SurfaceAnchor;
}
const vector = (v: THREE.Vector3) => v.toArray() as Vec3;
const inBounds = (v: Vec3) =>
  Math.abs(v[0]) <= 50 &&
  Math.abs(v[2]) <= 50 &&
  v[1] >= -0.00001 &&
  v[1] <= 100;
function visible(mesh: THREE.Mesh): boolean {
  for (let n: THREE.Object3D | null = mesh; n; n = n.parent)
    if (!n.visible) return false;
  const materials = Array.isArray(mesh.material)
    ? mesh.material
    : [mesh.material];
  return materials.some((m) => m.visible && (!m.transparent || m.opacity > 0));
}
/** Only explicitly registered model geometry participates; guides/effects never do. */
export class SurfacePicker {
  constructor(
    private space?: MotionSpace,
    private flatGround = true,
  ) {}
  setSpace(space?: MotionSpace, flatGround = true): void {
    this.space = space;
    this.flatGround = flatGround;
  }
  private allowed(v: Vec3): boolean {
    try {
      checkPoint(v, this.space);
      return true;
    } catch {
      return false;
    }
  }
  private meshes = new Map<
    string,
    { objectId: string; nodeId: string; mesh: THREE.Mesh }
  >();
  clear(): void {
    this.meshes.clear();
  }
  register(objectId: string, root: THREE.Object3D): void {
    const visit = (node: THREE.Object3D, path: string) => {
      if (node.userData.lifetimeHelper || node.userData.revealHighlightOverlay)
        return;
      if (
        (node as THREE.Mesh).isMesh &&
        !node.userData.lifetimeHelper &&
        !node.userData.revealHighlightOverlay
      ) {
        const nodeId = `${path}:${node.userData.nodeId ?? "mesh"}`;
        this.meshes.set(`${objectId}/${nodeId}`, {
          objectId,
          nodeId,
          mesh: node as THREE.Mesh,
        });
      }
      node.children.forEach((child, i) => visit(child, `${path}.${i}`));
    };
    visit(root, "root");
  }
  private intersections(ray: THREE.Raycaster): SurfaceHit[] {
    const entries = [...this.meshes.values()].filter((e) => visible(e.mesh));
    entries.forEach((e) => e.mesh.updateWorldMatrix(true, false));
    const lookup = new Map(entries.map((e) => [e.mesh, e]));
    return ray
      .intersectObjects(
        entries.map((e) => e.mesh),
        false,
      )
      .flatMap((hit) => {
        const entry = lookup.get(hit.object as THREE.Mesh);
        if (!entry || !hit.face) return [];
        const materials = entry.mesh.material;
        const material = Array.isArray(materials)
          ? materials[hit.face.materialIndex]
          : materials;
        if (
          !material?.visible ||
          (material.transparent && material.opacity <= 0)
        )
          return [];
        const localNormal = hit.face.normal.clone().normalize();
        const normal = localNormal
          .clone()
          .applyNormalMatrix(
            new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld),
          );
        const position = vector(hit.point);
        if (Math.abs(position[1]) < 0.00001) position[1] = 0;
        return [
          {
            position,
            surface: {
              objectId: entry.objectId,
              nodeId: entry.nodeId,
              localPosition: vector(hit.object.worldToLocal(hit.point.clone())),
              localNormal: vector(localNormal),
              position,
              normal: vector(normal),
            },
          },
        ];
      });
  }
  pick(ray: THREE.Raycaster): SurfaceHit | null {
    const hits = this.intersections(ray);
    const ground = this.flatGround
      ? ray.ray.intersectPlane(
          new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
          new THREE.Vector3(),
        )
      : null;
    const nearest = hits[0];
    if (
      nearest &&
      (!ground ||
        ray.ray.origin.distanceTo(new THREE.Vector3(...nearest.position)) <=
          ray.ray.origin.distanceTo(ground))
    )
      return this.allowed(nearest.position) ? nearest : null;
    return ground && this.allowed(vector(ground))
      ? { position: vector(ground) }
      : null;
  }
  vertical(x: number, z: number): SurfaceHit[] {
    const low = this.space?.min[1] ?? 0,
      high = this.space?.max[1] ?? 100;
    const hits = this.intersections(
      new THREE.Raycaster(
        new THREE.Vector3(x, high + 1, z),
        new THREE.Vector3(0, -1, 0),
        0,
        high - low + 2,
      ),
    );
    return [
      ...(this.flatGround ? [{ position: [x, 0, z] as Vec3 }] : []),
      ...hits.filter(
        (h) => this.allowed(h.position) && h.surface!.normal[1] > 0.35,
      ),
    ];
  }
  resolve(p: ActionPoint): ActionPoint {
    if (!p.surface) return structuredClone(p);
    const a = p.surface,
      entry = this.meshes.get(`${a.objectId}/${a.nodeId}`);
    if (!entry)
      throw new MotionError(
        "SURFACE_MISSING",
        `${p.name} 依附的模型表面已失效，请重新放置标点`,
      );
    entry.mesh.updateWorldMatrix(true, false);
    const position = vector(
      entry.mesh.localToWorld(new THREE.Vector3(...a.localPosition)),
    );
    const normal = vector(
      new THREE.Vector3(...a.localNormal).applyNormalMatrix(
        new THREE.Matrix3().getNormalMatrix(entry.mesh.matrixWorld),
      ),
    );
    const result: ActionPoint = {
      ...structuredClone(p),
      ground: [position[0], 0, position[2]],
      surface: { ...a, position, normal },
    };
    checkPoint(pointPosition(result), this.space);
    return result;
  }
}

/** Hysteresis is measured from the intended height, never from the last snapped height. */
export function magneticSurface(
  hits: SurfaceHit[],
  height: number,
  previous: SurfaceHit | null,
  bypass: boolean,
  enter = 0.65,
  release = 1.1,
): SurfaceHit | null {
  if (bypass) return null;
  if (previous && Math.abs(previous.position[1] - height) <= release)
    return previous;
  return (
    hits
      .filter((h) => Math.abs(h.position[1] - height) <= enter)
      .sort(
        (a, b) =>
          Math.abs(a.position[1] - height) - Math.abs(b.position[1] - height),
      )[0] ?? null
  );
}

export function pointOnSurface(p: ActionPoint, hit: SurfaceHit): ActionPoint {
  return {
    ...p,
    ground: [hit.position[0], 0, hit.position[2]],
    height: 0,
    offsetMode: "up",
    surface: hit.surface ? structuredClone(hit.surface) : undefined,
  };
}

export function pointAtHeight(
  p: ActionPoint,
  height: number,
  snap: SurfaceHit | null,
  limits: [number, number] = [0, 100],
): ActionPoint {
  if (snap) return pointOnSurface(p, snap);
  const start = pointPosition(p),
    base = p.surface?.position;
  const y =
    Math.round(Math.max(limits[0], Math.min(limits[1], height)) * 100) / 100;
  const keep =
    base &&
    Math.abs(base[0] - start[0]) < 0.00001 &&
    Math.abs(base[2] - start[2]) < 0.00001 &&
    y >= base[1];
  return keep
    ? { ...p, offsetMode: "up", height: y - base[1] }
    : {
        ...p,
        surface: undefined,
        ground: [start[0], Math.min(0, y), start[2]],
        offsetMode: "up",
        height: Math.max(0, y),
      };
}
