import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { Navigation } from "../src/client/navigation/navigation";
import { LocationResolver } from "../src/client/navigation/locationResolver";
import {
  buildSemanticIndex,
  type SpatialFeature,
} from "../src/client/navigation/semanticIndex";
import {
  connectedSequence,
  winding,
  crossesBoundary,
} from "../src/client/navigation/regionSearch";
import { normalizeMap } from "../src/client/rendering/map/shared/map";
import { pointPosition, type Vec3 } from "../src/shared/motion";
import type { MapResource } from "../src/shared/maps";
import type { SceneGeometry } from "../src/client/navigation/geometry";
import { buildSceneGeometry } from "../src/client/navigation/geometry";
import { assemblyFixture, sceneMap } from "./sceneFixtures";

type Floor = {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  y: number;
  id?: string;
};
async function world(floors: Floor[], features: SpatialFeature[] = []) {
  const resource: MapResource = {
    id: "regions",
    name: "regions",
    updatedAt: 1,
    scheme: null,
    map: normalizeMap({ box: { size: [40, 16, 40] } } as any),
  };
  const index = buildSemanticIndex(resource),
    root = new THREE.Group(),
    objects = new Map<string, THREE.Group>();
  for (const f of features) index.features.set(f.semantic.id, f);
  const positions: number[] = [],
    indices: number[] = [];
  for (const f of floors) {
    const id = f.id ?? "terrain";
    if (!objects.has(id)) {
      const group = new THREE.Group();
      objects.set(id, group);
      root.add(group);
    }
    const p = [
        f.x0,
        f.y,
        f.z0,
        f.x0,
        f.y,
        f.z1,
        f.x1,
        f.y,
        f.z0,
        f.x1,
        f.y,
        f.z1,
      ],
      g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
    g.setIndex([0, 1, 2, 2, 1, 3]);
    g.computeVertexNormals();
    objects
      .get(id)!
      .add(
        new THREE.Mesh(
          g,
          new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
        ),
      );
    const offset = positions.length / 3;
    positions.push(...p);
    indices.push(...[0, 1, 2, 2, 1, 3].map((n) => n + offset));
  }
  const geometry: SceneGeometry = {
    root,
    objects,
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    dispose() {
      root.traverse((n) => {
        if ((n as THREE.Mesh).isMesh) {
          const m = n as THREE.Mesh;
          m.geometry.dispose();
          (m.material as THREE.Material).dispose();
        }
      });
    },
  };
  const nav = new Navigation({
    radius: 0.1,
    height: 1.4,
    climb: 0.3,
    slope: 35,
  });
  await nav.build(geometry);
  return {
    resource,
    index,
    geometry,
    nav,
    resolver: new LocationResolver(index, geometry, nav),
    dispose() {
      nav.dispose();
      geometry.dispose();
    },
  };
}
const feature = (
  id: string,
  kind: SpatialFeature["semantic"]["kind"],
  min: Vec3,
  max: Vec3,
): SpatialFeature => ({
  semantic: {
    id: "object:" + id,
    name: id,
    kind,
    source: "name",
    queries: ["near", "center", "facing"],
    near: [],
  },
  objectId: id,
  min,
  max,
});

describe("local spatial region search", () => {
  it("finds diagonal standing areas missed by four cardinal probes", async () => {
    const w = await world(
      [{ x0: 3, x1: 5, z0: 3, z1: 5, y: 0 }],
      [feature("tree", "tree", [-0.5, 0, -0.5], [0.5, 4, 0.5])],
    );
    try {
      const result = await w.resolver.resolve({
        key: "near",
        featureId: "object:tree",
        relation: "near",
      });
      const p = pointPosition(result.points[0]);
      expect(p[0]).toBeGreaterThan(3);
      expect(p[2]).toBeGreaterThan(3);
      expect(() => w.nav.project(p)).not.toThrow();
    } finally {
      w.dispose();
    }
  });
  it("keeps overlapping floors separate and never reports a partial route as reachable", async () => {
    const w = await world([
      { x0: -3, x1: 3, z0: -3, z1: 3, y: 0 },
      { x0: -3, x1: 3, z0: -3, z1: 3, y: 4 },
    ]);
    try {
      const values = w.nav.candidates([-1, -0.1, -1], [1, 5, 1], [0, 0, 0]);
      expect(values.some((p) => p[1] < 0.2)).toBe(true);
      expect(values.some((p) => p[1] > 3.9)).toBe(true);
      expect(w.nav.componentAt([0, 0, 0])).not.toBe(
        w.nav.componentAt([0, 4, 0]),
      );
      expect(w.nav.pathLength([0, 0, 0], [0, 4, 0])).toBeNull();
      expect(() => w.nav.route([0, 0, 0], [0, 4, 0])).toThrow("不可达");
    } finally {
      w.dispose();
    }
  });
  it("selects a reachable near candidate even when another connected area scores closer", async () => {
    const w = await world(
      [
        { x0: -2.5, x1: -0.8, z0: -2, z1: 2, y: 0 },
        { x0: 2, x1: 6, z0: -2, z1: 2, y: 0 },
      ],
      [feature("tree", "tree", [-0.5, 0, -0.5], [0.5, 4, 0.5])],
    );
    try {
      const result = await w.resolver.resolve(
        { key: "near", featureId: "object:tree", relation: "near" },
        [5, 0, 0],
      );
      expect(pointPosition(result.points[0])[0]).toBeGreaterThan(2);
      expect(
        w.nav.pathLength([5, 0, 0], pointPosition(result.points[0])),
      ).not.toBeNull();
    } finally {
      w.dispose();
    }
  });
  it("prefers an origin connected to its planned destinations", async () => {
    const w = await world(
      [
        { x0: -1, x1: 1, z0: -1, z1: 1, y: 0 },
        { x0: 3, x1: 9, z0: -3, z1: 3, y: 0, id: "hall" },
      ],
      [feature("hall", "building", [3, 0, -3], [9, 5, 3])],
    );
    try {
      const result = await w.resolver.resolve(
        { key: "origin", featureId: "ground", relation: "near" },
        undefined,
        [{ key: "goal", featureId: "object:hall", relation: "center" }],
      );
      expect(pointPosition(result.points[0])[0]).toBeGreaterThan(3);
      const goal = await w.resolver.resolve(
        { key: "goal", featureId: "object:hall", relation: "center" },
        pointPosition(result.points[0]),
      );
      expect(
        w.nav.pathLength(
          pointPosition(result.points[0]),
          pointPosition(goal.points[0]),
        ),
      ).not.toBeNull();
    } finally {
      w.dispose();
    }
  });
  it("selects the pavilion floor under a roof, and refuses a roof-only substitute", async () => {
    const f = feature("pavilion", "building", [-3, 0, -3], [3, 6, 3]);
    for (const floor of [true, false]) {
      const w = await world(
        [
          ...(floor
            ? [{ x0: -3, x1: 3, z0: -3, z1: 3, y: 0, id: "pavilion" }]
            : []),
          { x0: -3, x1: 3, z0: -3, z1: 3, y: 6, id: "pavilion" },
        ],
        [f],
      );
      try {
        const query = w.resolver.resolve({
          key: "center",
          featureId: f.semantic.id,
          relation: "center",
        });
        if (floor)
          expect(pointPosition((await query).points[0])[1]).toBeCloseTo(0);
        else
          await expect(query).rejects.toMatchObject({
            code: "NO_STANDING_SURFACE",
          });
      } finally {
        w.dispose();
      }
    }
  });
  it("jointly snaps guide points onto a continuous strip instead of the nearest isolated patch", async () => {
    const w = await world([
      { x0: -0.9, x1: -0.2, z0: -4, z1: -2, y: 0 },
      { x0: 0.1, x1: 1, z0: -4, z1: 4, y: 0 },
    ]);
    w.resource.map.guides.push({
      id: "route",
      name: "route",
      points: [
        [-0.05, -3],
        [-0.05, 3],
      ],
      curve: "polyline",
      closed: false,
      width: 1,
      tags: ["path"],
    });
    const index = buildSemanticIndex(w.resource);
    try {
      const result = await new LocationResolver(
        index,
        w.geometry,
        w.nav,
      ).resolve({
        key: "route",
        featureId: "guide:route",
        relation: "alongGuide",
      });
      expect(result.points.every((p) => pointPosition(p)[0] > 0)).toBe(true);
      result.points.forEach((p) =>
        expect(Math.abs(pointPosition(p)[0] + 0.05)).toBeLessThanOrEqual(0.65),
      );
      expect(
        w.nav.pathLength(
          pointPosition(result.points[0]),
          pointPosition(result.points[1]),
        ),
      ).not.toBeNull();
    } finally {
      w.dispose();
    }
  });
  it("requires the return edge of a closed route, including when every forward edge works", () => {
    const layers: Vec3[][] = [[[0, 0, 0]], [[1, 0, 0]], [[2, 0, 0]]];
    const cost = (a: Vec3, b: Vec3) => (b[0] > a[0] ? b[0] - a[0] : null);
    expect(connectedSequence(layers, cost)).not.toBeNull();
    expect(connectedSequence(layers, cost, { closed: true })).toBeNull();
  });
  it("retains all guide stations for manual repair when its middle surface is missing", async () => {
    const w = await world([
      { x0: -4, x1: -2, z0: -1, z1: 1, y: 0 },
      { x0: 2, x1: 4, z0: -1, z1: 1, y: 0 },
    ]);
    w.resource.map.guides.push({
      id: "broken",
      name: "broken",
      points: [
        [-3, 0],
        [0, 2],
        [3, 0],
      ],
      curve: "polyline",
      closed: false,
      width: 1,
      tags: ["path"],
    });
    try {
      const resolver = new LocationResolver(
        buildSemanticIndex(w.resource),
        w.geometry,
        w.nav,
      );
      await expect(
        resolver.resolve({
          key: "broken",
          featureId: "guide:broken",
          relation: "alongGuide",
        }),
      ).rejects.toMatchObject({
        code: "NO_STANDING_SURFACE",
        closed: false,
        points: [
          { name: "p1" },
          { name: "p2", ground: [0, 0, 2] },
          { name: "p3" },
        ],
      });
    } finally {
      w.dispose();
    }
  });
  it("uses an irregular shoreline and encloses the entire water polygon", async () => {
    const map = structuredClone(sceneMap);
    map.map.objects = [];
    const boundary: [number, number][] = [
      [-4, -3],
      [4, -3],
      [0, 4],
    ];
    map.map.waterBodies[0].points = boundary;
    const geometry = await buildSceneGeometry(map.map),
      nav = new Navigation({ radius: 0.3, height: 1.4, climb: 0.3, slope: 35 });
    try {
      await nav.build(geometry);
      const result = await new LocationResolver(
        buildSemanticIndex(map),
        geometry,
        nav,
      ).resolve({
        key: "circuit",
        featureId: "water:pond",
        relation: "surroundingRoute",
      });
      expect(result.points).toHaveLength(3);
      const path = result.points.flatMap((p, i) =>
        nav.route(
          pointPosition(p),
          pointPosition(result.points[(i + 1) % result.points.length]),
        ),
      );
      expect(
        boundary.every(([x, z]) => Math.abs(winding(path, [x, 0, z])) > 6),
      ).toBe(true);
    } finally {
      nav.dispose();
      geometry.dispose();
    }
  });
  it("rejects a segment cutting a thin inlet even when both endpoints are dry", () => {
    const boundary: [number, number][] = [
      [-0.01, -1],
      [0.01, -1],
      [0.01, 1],
      [-0.01, 1],
    ];
    expect(crossesBoundary([-1, 0, 0], [1, 0, 0], boundary)).toBe(true);
    expect(crossesBoundary([-1, 0, 2], [1, 0, 2], boundary)).toBe(false);
  });
  it("validates an actual dry, full circuit rather than just closed waypoint coordinates", async () => {
    const w = await assemblyFixture();
    try {
      const result = await new LocationResolver(
        buildSemanticIndex(sceneMap),
        w.geometry,
        w.nav,
      ).resolve({
        key: "circuit",
        featureId: "water:pond",
        relation: "surroundingRoute",
      });
      const path = result.points.flatMap((p, i) =>
        w.nav.route(
          pointPosition(p),
          pointPosition(result.points[(i + 1) % result.points.length]),
        ),
      );
      expect(Math.abs(winding(path, [0, 0, 0]))).toBeGreaterThan(6);
      expect(
        path.every((p) => Math.abs(p[0]) >= 2 || Math.abs(p[2]) >= 3),
      ).toBe(true);
    } finally {
      w.dispose();
    }
  });
  it("adds source aliases and coarse sectors without geometry and bounds large summaries", () => {
    const map = structuredClone(sceneMap),
      prototype = map.map.objects[0];
    map.map.objects = Array.from({ length: 110 }, (_, i) => ({
      ...structuredClone(prototype),
      id: "tree" + i,
      name: "tree " + i,
    }));
    const bench = {
      ...structuredClone(prototype),
      id: "bench",
      name: "池边长椅",
    };
    bench.transform.position = [8, 0, -8];
    map.map.objects.unshift(bench);
    const index = buildSemanticIndex(map),
      json = JSON.stringify(index.summary);
    expect(index.features.has("object:bench")).toBe(true);
    expect(index.summary.features).toHaveLength(96);
    expect(index.summary.features.some((f) => f.id === "object:bench")).toBe(
      true,
    );
    expect(index.summary.omittedFeatures).toBeGreaterThan(0);
    expect(json).not.toMatch(
      /"(?:position|points|vertices|terrain|modelJson)"\s*:/,
    );
    expect(index.features.get("object:bench")?.semantic.sector).toBe(
      "northeast",
    );
    const ids = new Set(index.summary.features.map((f) => f.id));
    expect(
      index.summary.features.every((f) => f.near.every((id) => ids.has(id))),
    ).toBe(true);
  });
  it("exposes source aliases without inventing a verified navigation capability", () => {
    const map = structuredClone(sceneMap),
      object = map.map.objects[0];
    object.assetId = "bridge-asset";
    (map.map.assets ??= []).push({
      id: "bridge-asset",
      name: "玉栏桥",
      tags: ["stone bridge", "water crossing"],
      modelJson: {},
    } as any);
    const feature = buildSemanticIndex(map).summary.features.find(
      (f) => f.id === "object:bridge",
    )!;
    expect(feature.aliases).toEqual([
      "玉栏桥",
      "stone bridge",
      "water crossing",
    ]);
    expect(JSON.stringify(feature)).not.toContain("reachable");
  });
});
