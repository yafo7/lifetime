import type { MapResource, EditableMap } from "../../shared/maps";
import type { MapSemantics, SemanticFeature } from "../../shared/mapSemantics";
import { getMapObjectVisualAabbs } from "../rendering/map/shared/map";
import { waterBoundaryPoints } from "../rendering/map/shared/mapWater";
import type { Vec3 } from "../../shared/motion";

export interface SpatialFeature {
  semantic: SemanticFeature;
  objectId?: string;
  waterId?: string;
  guideId?: string;
  min: Vec3;
  max: Vec3;
}
export interface SemanticIndex {
  summary: MapSemantics;
  features: Map<string, SpatialFeature>;
  map: EditableMap;
}
const midpoint = (f: SpatialFeature): Vec3 =>
  f.min.map((v, i) => (v + f.max[i]) / 2) as Vec3;
function bounds(
  points: [number, number][],
  y: number,
): { min: Vec3; max: Vec3 } {
  return {
    min: [
      Math.min(...points.map((p) => p[0])),
      y,
      Math.min(...points.map((p) => p[1])),
    ],
    max: [
      Math.max(...points.map((p) => p[0])),
      y,
      Math.max(...points.map((p) => p[1])),
    ],
  };
}
export function buildSemanticIndex(resource: MapResource): SemanticIndex {
  const map = resource.map,
    features = new Map<string, SpatialFeature>();
  const add = (f: SpatialFeature) => features.set(f.semantic.id, f);
  add({
    semantic: {
      id: "ground",
      name: "地面",
      kind: "ground",
      source: "map",
      queries: ["near", "facing"],
      near: [],
    },
    min: [-map.box.size[0] / 2, 0, -map.box.size[2] / 2],
    max: [map.box.size[0] / 2, 0, map.box.size[2] / 2],
  });
  for (const water of map.waterBodies) {
    const points = waterBoundaryPoints(water);
    if (points.length < 3) continue;
    add({
      semantic: {
        id: "water:" + water.id,
        name: water.name,
        kind: "water",
        source: "map",
        queries: ["shore", "surroundingRoute", "facing"],
        near: [],
      },
      waterId: water.id,
      ...bounds(points, water.level),
    });
  }
  const boxes = new Map(
    getMapObjectVisualAabbs(map).map((b) => [b.objectId, b]),
  );
  for (const object of map.objects) {
    if (!object.visible || object.light || object.parentId) continue;
    const asset = map.assets?.find((a) => a.id === object.assetId);
    const label = [object.name, asset?.name, ...(asset?.tags ?? [])].join(" ");
    const kind: SemanticFeature["kind"] = /桥|bridge/i.test(label)
      ? "bridge"
      : /树|松|柏|柳|tree/i.test(label)
        ? "tree"
        : /厅|房|屋|亭|门|building|house|pavilion/i.test(label)
          ? "building"
          : "object";
    // Unknown props remain local; ornamental lights/rocks don't fill the planner context.
    if (kind === "object") continue;
    const box = boxes.get(object.id);
    if (!box) continue;
    add({
      semantic: {
        id: "object:" + object.id,
        name: object.name,
        kind,
        source: "name",
        queries:
          kind === "bridge" ? ["center", "near", "facing"] : ["near", "facing"],
        near: [],
      },
      objectId: object.id,
      min: box.min,
      max: box.max,
    });
  }
  for (const guide of map.guides) {
    if (
      guide.points.length < 2 ||
      !guide.tags.some((t) => /route|path|circulation/i.test(t))
    )
      continue;
    add({
      semantic: {
        id: "guide:" + guide.id,
        name: guide.name,
        kind: "path",
        source: "map",
        queries: ["alongGuide", "near", "facing"],
        near: [],
      },
      guideId: guide.id,
      ...bounds(guide.points, 0),
    });
  }
  for (const f of features.values()) {
    if (f.semantic.kind === "ground") continue;
    const center = midpoint(f);
    f.semantic.near = [...features.values()]
      .filter((other) => other !== f && other.semantic.kind !== "ground")
      .map((other) => ({
        id: other.semantic.id,
        d: Math.hypot(
          midpoint(other)[0] - center[0],
          midpoint(other)[2] - center[2],
        ),
      }))
      .filter((v) => v.d < 25)
      .sort((a, b) => a.d - b.d)
      .slice(0, 4)
      .map((v) => v.id);
  }
  return {
    map,
    features,
    summary: {
      mapId: resource.id,
      revision: resource.updatedAt,
      name: resource.name,
      features: [...features.values()].map((f) => f.semantic),
    },
  };
}
