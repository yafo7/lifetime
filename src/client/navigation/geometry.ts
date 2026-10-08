import * as THREE from "three";
import type { EditableMap } from "../../shared/maps";
import {
  terrainPointAt,
  getMapCollisionBake,
} from "../rendering/map/shared/map";
import { isPointInsidePlayableArea } from "../rendering/map/shared/mapLayout";
import { isPointInsideWaterBody } from "../rendering/map/shared/mapWater";
import { buildModelGroup } from "../rendering/map/client/modelRenderer";
import type { Vec3 } from "../../shared/motion";

/** CPU geometry independent of render batching/culling, with stable original node IDs. */
export interface SceneGeometry {
  root: THREE.Group;
  objects: Map<string, THREE.Group>;
  positions: Float32Array;
  indices: Uint32Array;
  dispose(): void;
}
export async function buildSceneGeometry(
  map: EditableMap,
  foundations: Map<string, THREE.Group> = new Map(),
): Promise<SceneGeometry> {
  const root = new THREE.Group(),
    objects = new Map<string, THREE.Group>(),
    templates = new Map<string, THREE.Group>();
  const dispose = () => {
    const gs = new Set<THREE.BufferGeometry>(),
      ms = new Set<THREE.Material>(),
      shared = new Set<THREE.BufferGeometry>(),
      sharedM = new Set<THREE.Material>();
    const collect = (
      node: THREE.Object3D,
      geometry: Set<THREE.BufferGeometry>,
      material: Set<THREE.Material>,
    ) =>
      node.traverse((n) => {
        const m = n as THREE.Mesh;
        if (m.isMesh) {
          geometry.add(m.geometry);
          (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) =>
            material.add(x),
          );
        }
      });
    collect(root, gs, ms);
    for (const t of templates.values()) collect(t, gs, ms);
    for (const f of foundations.values()) collect(f, shared, sharedM);
    gs.forEach((g) => {
      if (!shared.has(g)) g.dispose();
    });
    ms.forEach((m) => {
      if (!sharedM.has(m)) m.dispose();
    });
    root.clear();
  };
  const meshes: THREE.Mesh[] = [];
  const primitiveSolids = new Map<
    string,
    {
      complete: boolean;
      boxes: { bounds: THREE.Box3; inverse: THREE.Matrix4 }[];
    }
  >();
  const verts: number[] = [],
    indices: number[] = [];
  // Closed solid meshes must not leave a walkable floor inside their volume.
  // The map's primitive colliders preserve openings instead of boxing whole buildings.
  const solids = getMapCollisionBake(map);
  const insideSolid = (p: THREE.Vector3) =>
    [
      ...(solids.cells["*"] ?? []),
      ...(solids.cells[
        `${Math.floor(p.x / solids.cellSize)},${Math.floor(p.z / solids.cellSize)}`
      ] ?? []),
    ].some((i) => {
      const b = solids.boxes[i];
      const broad =
        p.x > b.min[0] &&
        p.x < b.max[0] &&
        p.z > b.min[2] &&
        p.z < b.max[2] &&
        p.y + 0.025 > b.min[1] &&
        p.y + 0.025 < b.max[1];
      if (!broad) return false;
      const precise = primitiveSolids.get(b.objectId);
      if (!precise?.complete) return true;
      // A rotated box's world AABB includes empty space above its actual sloping face.
      const above = p.clone();
      above.y += 0.025;
      return precise.boxes.some((box) => {
        const local = above.clone().applyMatrix4(box.inverse);
        return (
          local.x > box.bounds.min.x &&
          local.x < box.bounds.max.x &&
          local.y > box.bounds.min.y &&
          local.y < box.bounds.max.y &&
          local.z > box.bounds.min.z &&
          local.z < box.bounds.max.z
        );
      });
    });
  const vector = (p: Vec3) => new THREE.Vector3(...p);
  const wet = (p: THREE.Vector3) =>
    map.waterBodies.some(
      (w) => p.y < w.level + 0.01 && isPointInsideWaterBody(w, p.x, p.z, map),
    );
  const push = (
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    split = false,
  ) => {
    if (
      split &&
      Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)) > 0.6
    ) {
      const ab = a.clone().lerp(b, 0.5),
        bc = b.clone().lerp(c, 0.5),
        ca = c.clone().lerp(a, 0.5);
      push(a, ab, ca, true);
      push(ab, b, bc, true);
      push(ca, bc, c, true);
      push(ab, bc, ca, true);
      return;
    }
    const center = a
      .clone()
      .add(b)
      .add(c)
      .multiplyScalar(1 / 3);
    if (
      wet(center) ||
      !isPointInsidePlayableArea(map.layout, map.box.size, center.x, center.z)
    )
      return;
    if (b.clone().sub(a).cross(c.clone().sub(a)).y > 0 && insideSolid(center))
      return;
    const i = verts.length / 3;
    verts.push(...a.toArray(), ...b.toArray(), ...c.toArray());
    indices.push(i, i + 1, i + 2);
  };
  const groundVerts: number[] = [],
    groundIndices: number[] = [];
  for (let z = 0; z < map.terrain.resolutionZ; z++)
    for (let x = 0; x < map.terrain.resolutionX; x++)
      groundVerts.push(...terrainPointAt(map, x, z));
  for (let z = 0; z < map.terrain.resolutionZ - 1; z++)
    for (let x = 0; x < map.terrain.resolutionX - 1; x++) {
      const a = z * map.terrain.resolutionX + x,
        b = a + 1,
        c = a + map.terrain.resolutionX,
        d = c + 1;
      groundIndices.push(a, c, b, b, c, d);
    }
  const terrain = new THREE.Group(),
    g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(groundVerts, 3));
  g.setIndex(groundIndices);
  g.computeVertexNormals();
  terrain.add(
    new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })),
  );
  objects.set("terrain", terrain);
  root.add(terrain);
  try {
    for (const o of map.objects) {
      const group = new THREE.Group();
      group.userData.navigationObjectId = o.id;
      group.position.fromArray(o.transform.position);
      group.rotation.set(...o.transform.rotation);
      group.scale.set(
        ...(o.transform.scale.map((v, i) => v * o.transform.size[i]) as Vec3),
      );
      group.visible = o.visible;
      objects.set(o.id, group);
    }
    for (const o of map.objects) {
      const group = objects.get(o.id)!;
      const parent = o.parentId ? objects.get(o.parentId) : null;
      (parent ?? root).add(group);
      if (!o.visible || o.light) continue;
      let visual: THREE.Group | null = null;
      if (o.foundation && foundations.has(o.id)) {
        // Foundation geometry has its own terrain-following local transform.
        const original = foundations.get(o.id)!;
        for (const child of original.children) group.add(child.clone(true));
      } else if (o.assetId) {
        const asset = map.assets?.find((a) => a.id === o.assetId);
        if (!asset) throw new Error(`地图缺少模型：${o.name}`);
        let t = templates.get(asset.id);
        if (!t) {
          t = await buildModelGroup(asset.modelJson);
          templates.set(asset.id, t);
        }
        visual = t.clone(true);
      } else if (!o.foundation) {
        visual = new THREE.Group();
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(1, 1, 1),
          new THREE.MeshBasicMaterial(),
        );
        m.position.y = 0.5;
        visual.add(m);
      }
      if (visual) group.add(visual);
    }
    root.updateMatrixWorld(true);
    for (const [id, group] of objects) {
      if (id === "terrain") continue;
      group.traverse((n) => {
        if (!(n as THREE.Mesh).isMesh) return;
        let v: THREE.Object3D | null = n;
        while (v) {
          if (!v.visible) return;
          v = v.parent;
        }
        const m = n as THREE.Mesh;
        if (m.userData.editorHelper) return;
        const tags = JSON.stringify(m.userData.materialTags ?? []);
        if (/water/i.test(tags)) return;
        if (!meshes.includes(m)) meshes.push(m);
      });
    }
    for (const mesh of meshes) {
      let owner: THREE.Object3D | null = mesh;
      while (owner && !owner.userData.navigationObjectId) owner = owner.parent;
      const id = owner?.userData.navigationObjectId as string | undefined;
      if (!id) continue;
      let item = primitiveSolids.get(id);
      if (!item)
        primitiveSolids.set(id, (item = { complete: true, boxes: [] }));
      if (mesh.geometry.type !== "BoxGeometry") {
        item.complete = false;
        continue;
      }
      mesh.geometry.computeBoundingBox();
      item.boxes.push({
        bounds: mesh.geometry.boundingBox!.clone(),
        inverse: mesh.matrixWorld.clone().invert(),
      });
    }
    // Filter terrain after source primitive transforms are available, using the same solid test.
    for (let i = 0; i < groundIndices.length; i += 3)
      push(
        ...(groundIndices
          .slice(i, i + 3)
          .map((index) =>
            vector(groundVerts.slice(index * 3, index * 3 + 3) as Vec3),
          ) as [THREE.Vector3, THREE.Vector3, THREE.Vector3]),
        true,
      );
    for (const m of meshes) {
      const attr = m.geometry.getAttribute("position"),
        idx = m.geometry.index;
      if (!attr) continue;
      for (let i = 0; i < (idx?.count ?? attr.count); i += 3) {
        const points = [0, 1, 2].map((j) =>
          new THREE.Vector3()
            .fromBufferAttribute(attr, idx ? idx.getX(i + j) : i + j)
            .applyMatrix4(m.matrixWorld),
        );
        push(points[0], points[1], points[2]);
      }
    }
    return {
      root,
      objects,
      positions: new Float32Array(verts),
      indices: new Uint32Array(indices),
      dispose,
    };
  } catch (e) {
    dispose();
    throw e;
  }
}
