import type { Actor, Performance } from "./contracts";
import type { MapResource } from "./maps";
import type { LocationRelation, SemanticFeature } from "./mapSemantics";
import {
  sceneCatalogue,
  validateScenePlan,
  type SceneDesign,
} from "./scenePlan";
import { validatePoints } from "./motion";
import { mapSpace } from "./sceneMotion";

/** Validate persisted planning metadata separately from the executable state machine. */
export function validateSceneDesign(
  value: unknown,
  performance: Performance,
  actors: Actor[],
  map: MapResource,
): asserts value is SceneDesign {
  const design = value as SceneDesign;
  if (
    !design ||
    design.schemaVersion !== 1 ||
    typeof design.request !== "string" ||
    design.request.length > 8000 ||
    !Array.isArray(design.roles) ||
    design.roles.length > 8 ||
    !Array.isArray(design.plan?.actors)
  )
    throw new Error("场景设计记录无效");
  const queries: LocationRelation[] = [
    "near",
    "center",
    "shore",
    "surroundingRoute",
    "alongGuide",
    "facing",
  ];
  const features = new Map<string, SemanticFeature>();
  for (const role of design.plan.actors) {
    if (!Array.isArray(role.locations)) throw new Error("场景位置记录无效");
    for (const location of role.locations) {
      const id = location?.featureId;
      if (
        typeof id !== "string" ||
        !(
          id === "ground" ||
          (id.startsWith("object:") &&
            map.map.objects.some((o) => o.id === id.slice(7))) ||
          (id.startsWith("water:") &&
            map.map.waterBodies.some((w) => w.id === id.slice(6))) ||
          (id.startsWith("guide:") &&
            map.map.guides.some((g) => g.id === id.slice(6)))
        )
      )
        throw new Error("场景设计引用未知地图地点");
      features.set(id, {
        id,
        name: id,
        kind: "object",
        source: "map",
        near: [],
        queries,
      });
    }
  }
  validateScenePlan(
    design.plan,
    sceneCatalogue(
      {
        mapId: map.id,
        revision: map.updatedAt,
        name: map.name,
        features: [...features.values()],
      },
      actors,
      performance.instances,
    ),
  );
  if (design.roles.length !== design.plan.actors.length)
    throw new Error("场景角色记录不完整");
  const ids = new Set<string>(),
    keys = new Set<string>();
  for (const role of design.roles) {
    const intent = design.plan.actors.find((p) => p.key === role?.key),
      instance = performance.instances.find((i) => i.id === role?.instanceId);
    if (
      !intent ||
      !instance?.sceneMotion ||
      intent.instanceId !== instance.id ||
      ids.has(instance.id) ||
      keys.has(role.key) ||
      !role.actions ||
      !role.locations
    )
      throw new Error("场景角色记录与演出不匹配");
    ids.add(instance.id);
    keys.add(role.key);
    validatePoints(role.points, mapSpace(map.map));
    if (
      Object.keys(role.actions).length !== intent.actions.length ||
      intent.actions.some(
        (a) =>
          !instance.sceneMotion!.actions.some(
            (b) => b.id === role.actions[a.key],
          ),
      )
    )
      throw new Error("场景动作记录无效");
    if (
      Object.keys(role.locations).length !== intent.locations.length ||
      intent.locations.some(
        (l) =>
          !Array.isArray(role.locations[l.key]) ||
          !role.locations[l.key].length ||
          role.locations[l.key].some(
            (id) => !role.points.some((p) => p.id === id),
          ),
      )
    )
      throw new Error("场景标点记录无效");
  }
}
