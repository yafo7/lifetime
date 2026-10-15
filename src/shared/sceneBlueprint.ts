import type {
  SceneActorPlan,
  SceneCatalogue,
  ScenePlan,
  SceneStep,
} from "./scenePlan";
import { validateScenePlan } from "./scenePlan";

export type ModelRequirement =
  | { source: "existing"; actorId: string; modelRevisionId: string }
  | { source: "generate"; description: string };
export type AnimationRequirement = { key: string; name: string } & (
  | { source: "existing"; clipId: string }
  | {
      source: "generate";
      description: string;
      mode: "quick" | "pro";
      loop: boolean;
    }
);
export interface BlueprintActor extends Omit<
  SceneActorPlan,
  "actorId" | "modelRevisionId"
> {
  model: ModelRequirement;
  animations: AnimationRequirement[];
}
export interface SceneBlueprint {
  schemaVersion: 1;
  name: string;
  actors: BlueprintActor[];
  removeInstanceIds?: string[];
}
export interface RoleAssets {
  actorId: string;
  modelRevisionId: string;
  animations: Record<string, string>;
}
export type AssetManifest = Record<string, RoleAssets>;

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    throw new Error("指导文档包含无效字段");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 100): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error("素材描述或名称无效");
}
function key(value: unknown) {
  text(value);
  if (
    !/^[\w-]+$/.test(value) ||
    ["__proto__", "constructor", "prototype"].includes(value)
  )
    throw new Error("素材标识无效");
}
/** Resolve logical keys without another LLM request. Single shots repeat as separate steps. */
export function resolveBlueprint(
  blueprint: SceneBlueprint,
  manifest: AssetManifest,
  catalogue: SceneCatalogue,
): ScenePlan {
  const actors = blueprint.actors.map((role) => {
    const assets = manifest[role.key];
    if (!assets) throw new Error(`缺少 ${role.name} 的素材`);
    const actions = role.actions.map((action) => ({
      ...action,
      steps: action.steps.flatMap<SceneStep>((step) => {
        if (!("animation" in step)) return [step];
        const id = assets.animations[step.animation];
        if (!id) throw new Error(`缺少动画 ${step.animation}`);
        const bound = { ...step, animation: id };
        if (bound.type === "playClip")
          return Array.from({ length: bound.repetitions }, () => ({
            ...bound,
            repetitions: 1,
          }));
        return [bound];
      }),
    }));
    const { model: _model, animations: _animations, ...intent } = role;
    return {
      ...intent,
      actorId: assets.actorId,
      modelRevisionId: assets.modelRevisionId,
      actions,
    };
  });
  return validateScenePlan(
    {
      schemaVersion: 1,
      name: blueprint.name,
      actors,
      ...(blueprint.removeInstanceIds
        ? { removeInstanceIds: blueprint.removeInstanceIds }
        : {}),
    },
    catalogue,
  );
}

/** Validate every map/action/state intention before submitting paid generation requests. */
export function validateBlueprint(
  value: unknown,
  catalogue: SceneCatalogue,
): SceneBlueprint {
  const root = object(value, [
    "schemaVersion",
    "name",
    "actors",
    "removeInstanceIds",
  ]);
  if (
    root.schemaVersion !== 1 ||
    !Array.isArray(root.actors) ||
    !root.actors.length ||
    root.actors.length > 8
  )
    throw new Error("指导文档版本或角色数量无效");
  text(root.name);
  const synthetic = structuredClone(catalogue),
    manifest: AssetManifest = {};
  for (const input of root.actors) {
    const role = object(input, [
      "key",
      "name",
      "model",
      "animations",
      "instanceId",
      "origin",
      "locations",
      "actions",
      "states",
      "initialState",
    ]);
    key(role.key);
    text(role.name);
    if (manifest[role.key as string]) throw new Error("角色标识重复");
    const model = object(role.model, [
      "source",
      "actorId",
      "modelRevisionId",
      "description",
    ]);
    let actorId: string, revision: string;
    if (model.source === "existing") {
      object(role.model, ["source", "actorId", "modelRevisionId"]);
      text(model.actorId);
      text(model.modelRevisionId);
      actorId = model.actorId;
      revision = model.modelRevisionId;
      if (
        !synthetic.actors
          .find((a) => a.id === actorId)
          ?.models.find((m) => m.id === revision)
      )
        throw new Error("复用的演员模型不存在");
    } else if (model.source === "generate") {
      object(role.model, ["source", "description"]);
      text(model.description, 4000);
      actorId = `new-${role.key}`;
      revision = `model-${role.key}`;
      if (role.instanceId !== undefined) {
        const instance = synthetic.instances.find(
          (i) => i.id === role.instanceId,
        );
        if (!instance) throw new Error("待更新角色不存在");
        actorId = instance.actorId;
        instance.modelRevisionId = revision;
      }
      let actor = synthetic.actors.find((a) => a.id === actorId);
      if (!actor) {
        actor = { id: actorId, name: role.name as string, models: [] };
        synthetic.actors.push(actor);
      }
      actor.models.push({ id: revision, animations: [] });
    } else throw new Error("模型需求必须选择复用或生成");
    if (
      !Array.isArray(role.animations) ||
      role.animations.length > 12 ||
      !role.animations.length
    )
      throw new Error("每个角色需要1–12个动画素材");
    const assets: RoleAssets = (manifest[role.key as string] = {
      actorId,
      modelRevisionId: revision,
      animations: {},
    });
    const target = synthetic.actors
      .find((a) => a.id === actorId)!
      .models.find((m) => m.id === revision)!;
    for (const inputAnimation of role.animations) {
      const animation = object(inputAnimation, [
        "key",
        "name",
        "source",
        "clipId",
        "description",
        "mode",
        "loop",
      ]);
      key(animation.key);
      text(animation.name);
      if (assets.animations[animation.key as string])
        throw new Error("动画标识重复");
      if (animation.source === "existing") {
        object(inputAnimation, ["key", "name", "source", "clipId"]);
        text(animation.clipId);
        if (!target.animations.some((c) => c.id === animation.clipId))
          throw new Error("复用动画必须属于指定模型版本");
        assets.animations[animation.key as string] = animation.clipId;
      } else if (animation.source === "generate") {
        object(inputAnimation, [
          "key",
          "name",
          "source",
          "description",
          "mode",
          "loop",
        ]);
        text(animation.description, 4000);
        if (
          !["quick", "pro"].includes(String(animation.mode)) ||
          typeof animation.loop !== "boolean"
        )
          throw new Error("动画模式或循环要求无效");
        const id = `generated-${role.key}-${animation.key}`;
        assets.animations[animation.key as string] = id;
        target.animations.push({
          id,
          name: animation.name as string,
          loop: animation.loop,
          duration: 1,
        });
      } else throw new Error("动画需求必须选择复用或生成");
    }
  }
  const blueprint = structuredClone(value) as SceneBlueprint;
  resolveBlueprint(blueprint, manifest, synthetic);
  return blueprint;
}
