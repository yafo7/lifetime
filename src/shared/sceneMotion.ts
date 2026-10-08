import type { Actor, ActorInstance } from "./contracts";
import type { EditableMap } from "./maps";
import { resolveBoundAction, type BoundAction } from "./actionBinding";
import {
  validateCharacterMachine,
  type CharacterMachine,
} from "./characterMachine";
import {
  checkPoint,
  validateAction,
  validatePoints,
  type ActionPoint,
  type MotionContext,
  type MotionPlan,
  type MotionSpace,
} from "./motion";

export interface NavigationProfile {
  radius: number;
  height: number;
  climb: number;
  slope: number;
}
export interface SceneAction {
  id: string;
  name: string;
  plan: MotionPlan;
  sourceActionId?: string;
}
export interface SceneMotion {
  schemaVersion: 1 | 2;
  points: ActionPoint[];
  actions: (SceneAction | BoundAction)[];
  selectedActionId: string | null;
  startPointId: string | null;
  navigation: NavigationProfile;
  machine?: CharacterMachine;
}
export function mapSpace(map: EditableMap): MotionSpace {
  const minY =
    map.terrain.heights.reduce((min, y) => Math.min(min, y), 0) -
    map.box.size[1];
  return {
    min: [-map.box.size[0] / 2, minY, -map.box.size[2] / 2],
    max: [
      map.box.size[0] / 2,
      Math.max(100, map.box.size[1] * 4),
      map.box.size[2] / 2,
    ],
  };
}
export function sceneContext(
  actor: Actor,
  instance: ActorInstance,
  map: EditableMap,
): MotionContext {
  return {
    actor,
    modelRevisionId: instance.modelRevisionId,
    points: instance.sceneMotion?.points ?? [],
    space: mapSpace(map),
  };
}
export function validateSceneMotion(
  value: SceneMotion,
  actor: Actor,
  instance: ActorInstance,
  map: EditableMap,
): void {
  if (
    !value ||
    ![1, 2].includes(value.schemaVersion) ||
    !Array.isArray(value.actions) ||
    value.actions.length > 100 ||
    !Array.isArray(value.points) ||
    value.points.length > 100 ||
    Object.keys(value).some(
      (k) =>
        ![
          "schemaVersion",
          "points",
          "actions",
          "selectedActionId",
          "startPointId",
          "navigation",
          "machine",
        ].includes(k),
    )
  )
    throw new Error("场景动作配置无效");
  const n = value.navigation;
  if (
    !n ||
    ![n.radius, n.height, n.climb, n.slope].every(Number.isFinite) ||
    n.radius < 0.05 ||
    n.radius > 20 ||
    n.height < 0.1 ||
    n.height > 100 ||
    n.climb < 0 ||
    n.climb > 5 ||
    n.slope < 0 ||
    n.slope > 60
  )
    throw new Error("角色通行尺寸或坡度无效");
  const ctx = {
    ...sceneContext(actor, instance, map),
    points: value.points,
    allowUnplacedPoints: true,
  };
  validatePoints(value.points, ctx.space);
  const ids = new Set<string>();
  for (const a of value.actions) {
    if (
      !a ||
      typeof a.id !== "string" ||
      !a.id ||
      a.id.length > 100 ||
      ids.has(a.id) ||
      typeof a.name !== "string" ||
      !a.name.trim() ||
      a.name.length > 100 ||
      (value.schemaVersion === 1
        ? !("plan" in a) || a.plan?.schemaVersion !== 2
        : "plan" in a)
    )
      throw new Error("场景动作名称、版本或 ID 无效");
    ids.add(a.id);
    if (
      !("plan" in a) &&
      (typeof a.actorActionId !== "string" ||
        !Number.isFinite(a.actorActionUpdatedAt) ||
        a.actorActionUpdatedAt < 0 ||
        Object.keys(a).some(
          (k) =>
            ![
              "id",
              "name",
              "actorActionId",
              "actorActionUpdatedAt",
              "bindings",
            ].includes(k),
        ))
    )
      throw new Error("演员动作引用无效");
    const plan = sceneActionPlan(a, ctx, false);
    if (
      plan.steps.some(
        (s) =>
          s.type === "moveTo" && (s.path?.mode === "air" || !!s.path?.height),
      )
    )
      throw new Error("场景动作当前仅支持地面导航，请使用地面目标点");
    if (plan.start !== undefined) throw new Error("请通过场景起始站位指定起点");
  }
  if (value.selectedActionId !== null && !ids.has(value.selectedActionId))
    throw new Error("所选场景动作不存在");
  if (value.machine !== undefined) validateCharacterMachine(value.machine, ids);
  if (
    value.startPointId !== null &&
    !value.points.some((p) => p.id === value.startPointId && p.ground)
  )
    throw new Error("起始站位不存在或未放置");
  checkPoint(instance.position, ctx.space);
}
/** Legacy plans are read-compatible only. New scene actions contain references and bindings. */
export function sceneActionPlan(
  action: SceneAction | BoundAction,
  ctx: MotionContext,
  strict = true,
): MotionPlan {
  return "plan" in action
    ? validateAction(action.plan, ctx)
    : resolveBoundAction(ctx.actor, action, ctx, strict);
}
