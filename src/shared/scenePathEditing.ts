import type { Actor } from "./contracts";
import { actionInputs, actorAction, routeOnlyInputs } from "./actionBinding";
import type { SceneMotion } from "./sceneMotion";

/** Transactional map edit: never mutates an actor action or the caller's scene. */
export function removeScenePathPoint(
  config: SceneMotion,
  id: string,
  actor: Actor,
  revision: string,
): SceneMotion {
  if (!config.points.some((p) => p.id === id)) throw new Error("标点不存在");
  if (config.startPointId === id)
    throw new Error("此点是 NPC 的起始站位，不能删除；可以拖动调整位置");
  const draft = structuredClone(config);
  for (const action of draft.actions) {
    if ("plan" in action) {
      if (
        actionInputs({ plan: action.plan }).some(
          (slot) => slot.id === "point:" + id,
        )
      )
        throw new Error(
          "此点被旧版内嵌动作引用，请先将旧动作迁入演员库再修改路径",
        );
    } else {
      const slots = Object.entries(action.bindings)
        .filter(([, value]) => value === id)
        .map(([key]) => key);
      if (!slots.length) continue;
      const removable = routeOnlyInputs(actorAction(actor, action, revision));
      if (slots.some((slot) => !removable.has(slot)))
        throw new Error(
          "此点被动作终点或朝向目标引用，不能删除；可以拖动调整位置",
        );
      action.excludedRouteInputs = [
        ...new Set([...(action.excludedRouteInputs ?? []), ...slots]),
      ];
      for (const slot of slots) delete action.bindings[slot];
    }
  }
  draft.points = draft.points.filter((p) => p.id !== id);
  return draft;
}
