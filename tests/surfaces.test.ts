import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  SurfacePicker,
  magneticSurface,
  pointOnSurface,
  pointAtHeight,
} from "../src/client/rendering/surfacePicker";
import {
  pointPosition,
  validatePoints,
  type ActionPoint,
} from "../src/shared/motion";

const point: ActionPoint = { id: "point", name: "p1", ground: null, height: 0 };
function fixture() {
  const picker = new SurfacePicker(),
    root = new THREE.Group();
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(4, 2, 4),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  );
  box.position.y = 4;
  root.add(box);
  picker.register("tree", root);
  return { picker, root, box };
}
describe("model surface anchors", () => {
  it("lifts on a fixed world axis, retaining an upward surface anchor and detaching below it", () => {
    const { picker } = fixture();
    const hit = picker.pick(
      new THREE.Raycaster(
        new THREE.Vector3(0, 10, 0),
        new THREE.Vector3(0, -1, 0),
      ),
    )!;
    const p = pointOnSurface(point, hit);
    const above = pointAtHeight(p, 7, null);
    expect(above.surface).toEqual(p.surface);
    expect(pointPosition(above)).toEqual([0, 7, 0]);
    const below = pointAtHeight(p, 2, null);
    expect(below.surface).toBeUndefined();
    expect(pointPosition(below)).toEqual([0, 2, 0]);
    expect(pointAtHeight(below, 4.9, hit).surface).toEqual(hit.surface);
    const fractional = {
      ...p,
      surface: {
        ...p.surface!,
        position: [0, 5.1234, 0] as [number, number, number],
      },
    };
    validatePoints([pointAtHeight(fractional, 100, null)]);
  });
  it("hits the closest visible model face before ground, ignoring invisible meshes and unregistered helpers", () => {
    const { picker, box } = fixture();
    const ray = new THREE.Raycaster(
      new THREE.Vector3(0, 10, 0),
      new THREE.Vector3(0, -1, 0),
    );
    expect(picker.pick(ray)?.position).toEqual([0, 5, 0]);
    expect(picker.pick(ray)?.surface?.objectId).toBe("tree");
    box.visible = false;
    expect(picker.pick(ray)).toEqual({ position: [0, 0, 0] });
    box.visible = true;
    (box.material as THREE.Material).visible = false;
    expect(picker.pick(ray)?.surface).toBeUndefined();
    expect(
      picker.pick(
        new THREE.Raycaster(
          new THREE.Vector3(51, 10, 0),
          new THREE.Vector3(0, -1, 0),
        ),
      ),
    ).toBeNull();
  });
  it("stores local coordinates, follows transforms and resolves non-uniformly scaled surface normals", () => {
    const { picker, root, box } = fixture();
    const hit = picker.pick(
      new THREE.Raycaster(
        new THREE.Vector3(10, 4, 0),
        new THREE.Vector3(-1, 0, 0),
      ),
    )!;
    const p = pointOnSurface(point, hit);
    expect(pointPosition(p)).toEqual([2, 4, 0]);
    root.position.x = 5;
    root.rotation.z = Math.PI / 6;
    root.scale.set(2, 1, 0.5);
    const resolved = picker.resolve({ ...p, offsetMode: "normal", height: 2 });
    const expected = new THREE.Vector3(...p.surface!.localPosition);
    box.localToWorld(expected);
    const normal = new THREE.Vector3(1, 0, 0).applyNormalMatrix(
      new THREE.Matrix3().getNormalMatrix(box.matrixWorld),
    );
    expected.addScaledVector(normal, 2);
    expect(pointPosition(resolved)).toEqual(expected.toArray());
    validatePoints([resolved]);
    picker.clear();
    expect(() => picker.resolve(p)).toThrow("重新放置");
  });
  it("uses nearby upward surfaces rather than undersides and applies hysteresis with Alt bypass", () => {
    const { picker } = fixture();
    const hits = picker.vertical(0, 0);
    expect(hits.map((h) => h.position[1])).toContain(5);
    expect(hits.map((h) => h.position[1])).not.toContain(3);
    const snap = magneticSurface(hits, 4.5, null, false);
    expect(snap?.position[1]).toBe(5);
    expect(magneticSurface(hits, 5.9, snap, false)).toBe(snap);
    expect(magneticSurface(hits, 6.2, snap, false)).toBeNull();
    expect(magneticSurface(hits, 5, snap, true)).toBeNull();
    expect(magneticSurface(hits, 2, null, false)).toBeNull();
  });
  it("preserves legacy points and rejects malformed anchors or offsets outside bounds", () => {
    const old = {
      ...point,
      ground: [1, 0, 2] as [number, number, number],
      height: 3,
    };
    validatePoints([old]);
    expect(pointPosition(old)).toEqual([1, 3, 2]);
    const { picker } = fixture();
    const p = pointOnSurface(
      point,
      picker.pick(
        new THREE.Raycaster(
          new THREE.Vector3(0, 10, 0),
          new THREE.Vector3(0, -1, 0),
        ),
      )!,
    );
    expect(() => validatePoints([{ ...p, height: 100 }])).toThrow("范围");
    expect(() =>
      validatePoints([
        { ...p, surface: { ...p.surface!, localNormal: [0, 0, 0] } },
      ]),
    ).toThrow("法线");
  });
});
