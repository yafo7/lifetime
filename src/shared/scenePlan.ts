import type { Actor, ActorInstance, Performance } from "./contracts";
import type { ActionPoint } from "./motion";
import type { MapSemantics, LocationIntent } from "./mapSemantics";
export type SceneStep =
  | {
      type: "moveTo";
      target: string;
      animation: string;
      speed: number;
      rate: number;
    }
  | {
      type: "followRoute";
      route: string;
      animation: string;
      speed: number;
      rate: number;
    }
  | { type: "playClip"; animation: string; rate: number; repetitions: number }
  | { type: "face"; target: string }
  | { type: "wait"; seconds: number };
export interface SceneActionIntent {
  key: string;
  name: string;
  steps: SceneStep[];
}
export interface SceneActorPlan {
  key: string;
  name: string;
  actorId: string;
  modelRevisionId: string;
  instanceId?: string;
  origin: string;
  locations: LocationIntent[];
  actions: SceneActionIntent[];
  states: {
    key: string;
    name: string;
    action: string;
    repetitions: number;
    waitSeconds: number;
    next: string | null;
  }[];
  initialState: string;
}
export interface ScenePlan {
  schemaVersion: 1;
  name: string;
  actors: SceneActorPlan[];
  removeInstanceIds?: string[];
}
export interface SceneDesign {
  schemaVersion: 1;
  request: string;
  plan: ScenePlan;
  roles: {
    key: string;
    instanceId: string;
    actions: Record<string, string>;
    locations: Record<string, string[]>;
    points: ActionPoint[];
  }[];
}
export interface SceneCatalogue {
  map: MapSemantics;
  actors: {
    id: string;
    name: string;
    models: {
      id: string;
      animations: {
        id: string;
        name: string;
        duration: number;
        loop: boolean;
      }[];
    }[];
  }[];
  instances: {
    id: string;
    actorId: string;
    modelRevisionId: string;
    actions: { id: string; name: string }[];
    states: {
      id: string;
      name: string;
      actionId: string;
      repetitions: number;
      waitSeconds: number;
      nextStateId: string | null;
    }[];
    initialStateId?: string;
  }[];
}
export function sceneCatalogue(
  map: MapSemantics,
  actors: Actor[],
  instances: ActorInstance[],
): SceneCatalogue {
  return {
    map,
    actors: actors.map((a) => ({
      id: a.id,
      name: a.name,
      models: a.modelRevisions
        .map((m) => ({
          id: m.id,
          animations: a.animations
            .filter((c) => c.modelRevisionId === m.id)
            .map((c) => ({
              id: c.id,
              name: c.name,
              duration: c.duration,
              loop: Boolean((c.animation as { loop?: boolean })?.loop),
            })),
        }))
        .filter((m) => m.animations.length),
    })),
    instances: instances.map((i) => ({
      id: i.id,
      actorId: i.actorId,
      modelRevisionId: i.modelRevisionId,
      actions:
        i.sceneMotion?.actions.map((a) => ({ id: a.id, name: a.name })) ?? [],
      states: i.sceneMotion?.machine?.states.map((s) => ({ ...s })) ?? [],
      initialStateId: i.sceneMotion?.machine?.initialStateId,
    })),
  };
}
/** Reflect current manual state edits without exposing point coordinates to the planner. */
export function currentScenePlan(
  performance: Performance,
): ScenePlan | undefined {
  if (!performance.sceneDesign) return;
  const plan = structuredClone(performance.sceneDesign.plan);
  for (const role of plan.actors) {
    const saved = performance.sceneDesign.roles.find((r) => r.key === role.key),
      machine = performance.instances.find((i) => i.id === saved?.instanceId)
        ?.sceneMotion?.machine;
    if (!saved || !machine) continue;
    const states = machine.states.map((s) => ({
      key: s.id,
      name: s.name,
      action: Object.keys(saved.actions).find(
        (key) => saved.actions[key] === s.actionId,
      ),
      repetitions: s.repetitions,
      waitSeconds: s.waitSeconds,
      next: s.nextStateId,
    }));
    if (states.every((s) => s.action)) {
      role.states = states as SceneActorPlan["states"];
      role.initialState = machine.initialStateId;
    }
  }
  return plan;
}
const object = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function fields(
  v: unknown,
  allowed: string[],
): asserts v is Record<string, any> {
  if (!object(v) || Object.keys(v).some((k) => !allowed.includes(k)))
    throw new Error("场景计划包含无效字段");
}
function text(v: unknown, max = 100): asserts v is string {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw new Error("场景计划名称或引用无效");
}
function number(v: unknown, min: number, max: number, integer = false) {
  if (
    typeof v !== "number" ||
    !Number.isFinite(v) ||
    v < min ||
    v > max ||
    (integer && !Number.isInteger(v))
  )
    throw new Error("场景计划参数超出范围");
}
function list(v: unknown, max: number): asserts v is Record<string, any>[] {
  if (!Array.isArray(v) || !v.length || v.length > max)
    throw new Error("场景计划列表为空或过大");
}
function unique(v: Record<string, any>[]): Set<string> {
  const result = new Set<string>();
  for (const x of v) {
    text(x.key);
    if (
      !/^[\w-]+$/.test(x.key) ||
      ["__proto__", "constructor", "prototype"].includes(x.key) ||
      result.has(x.key)
    )
      throw new Error("场景计划标识重复或无效");
    result.add(x.key);
  }
  return result;
}
/** AI output is an intent document, never an executable script or coordinate file. */
export function validateScenePlan(
  value: unknown,
  catalogue: SceneCatalogue,
): ScenePlan {
  fields(value, ["schemaVersion", "name", "actors", "removeInstanceIds"]);
  if (value.schemaVersion !== 1) throw new Error("场景计划版本无效");
  text(value.name);
  list(value.actors, 8);
  unique(value.actors);
  const instanceIds = new Set<string>();
  for (const a of value.actors) {
    fields(a, [
      "key",
      "name",
      "actorId",
      "modelRevisionId",
      "instanceId",
      "origin",
      "locations",
      "actions",
      "states",
      "initialState",
    ]);
    text(a.name);
    const actor = catalogue.actors.find((x) => x.id === a.actorId),
      model = actor?.models.find((m) => m.id === a.modelRevisionId);
    if (!model) throw new Error("计划引用不存在或没有动画的演员模型");
    if (a.instanceId !== undefined) {
      const i = catalogue.instances.find((i) => i.id === a.instanceId);
      if (
        !i ||
        i.actorId !== a.actorId ||
        i.modelRevisionId !== a.modelRevisionId ||
        instanceIds.has(i.id)
      )
        throw new Error("计划的实例引用无效或重复");
      instanceIds.add(i.id);
    }
    list(a.locations, 12);
    const locations = unique(a.locations);
    for (const l of a.locations) {
      fields(l, ["key", "featureId", "relation"]);
      const feature = catalogue.map.features.find((f) => f.id === l.featureId);
      if (!feature || !feature.queries.includes(l.relation))
        throw new Error("位置意图引用了未知地点或不支持的查询");
    }
    if (!locations.has(a.origin)) throw new Error("角色初始位置不存在");
    if (a.locations.find((l) => l.key === a.origin)?.relation === "facing")
      throw new Error("朝向点不能作为初始站位");
    list(a.actions, 12);
    const actions = unique(a.actions);
    for (const action of a.actions) {
      fields(action, ["key", "name", "steps"]);
      text(action.name);
      list(action.steps, 30);
      for (const step of action.steps) {
        if (step.type === "moveTo" || step.type === "followRoute") {
          fields(
            step,
            step.type === "moveTo"
              ? ["type", "target", "animation", "speed", "rate"]
              : ["type", "route", "animation", "speed", "rate"],
          );
          const location = a.locations.find(
            (l) =>
              l.key === (step.type === "moveTo" ? step.target : step.route),
          );
          if (!location || location.relation === "facing")
            throw new Error("移动目标无效");
          if (
            step.type === "followRoute" &&
            !["surroundingRoute", "alongGuide"].includes(location.relation)
          )
            throw new Error("路线步骤需要路线意图");
          if (!model.animations.some((c) => c.id === step.animation && c.loop))
            throw new Error("移动需要当前模型的循环动画");
          number(step.speed, 0.1, 10);
          number(step.rate, 0.25, 3);
        } else if (step.type === "playClip") {
          fields(step, ["type", "animation", "rate", "repetitions"]);
          const c = model.animations.find((c) => c.id === step.animation);
          if (!c) throw new Error("表演动画不存在或模型不匹配");
          number(step.rate, 0.25, 3);
          number(step.repetitions, 1, 20, true);
          if (!c.loop && step.repetitions !== 1)
            throw new Error("非循环动画只能播放一次");
        } else if (step.type === "face") {
          fields(step, ["type", "target"]);
          if (!locations.has(step.target)) throw new Error("朝向目标不存在");
        } else if (step.type === "wait") {
          fields(step, ["type", "seconds"]);
          number(step.seconds, 0, 60);
        } else throw new Error("未知动作步骤");
      }
    }
    list(a.states, 12);
    const states = unique(a.states);
    if (!states.has(a.initialState)) throw new Error("初始状态不存在");
    for (const s of a.states) {
      fields(s, [
        "key",
        "name",
        "action",
        "repetitions",
        "waitSeconds",
        "next",
      ]);
      text(s.name);
      if (!actions.has(s.action) || !(s.next === null || states.has(s.next)))
        throw new Error("状态引用不存在的动作或后续状态");
      number(s.repetitions, 1, 100, true);
      number(s.waitSeconds, 0, 3600);
    }
  }
  if (value.removeInstanceIds !== undefined) {
    if (
      !Array.isArray(value.removeInstanceIds) ||
      new Set(value.removeInstanceIds).size !==
        value.removeInstanceIds.length ||
      value.removeInstanceIds.some(
        (id) =>
          typeof id !== "string" ||
          !catalogue.instances.some((i) => i.id === id) ||
          instanceIds.has(id),
      )
    )
      throw new Error("待移除实例无效");
  }
  return structuredClone(value) as unknown as ScenePlan;
}
