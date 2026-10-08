import type { Actor } from "./contracts";
import {
  pointPosition,
  resolveClip,
  validateAction,
  MotionError,
  type SavedAction,
  type Target,
  type Vec3,
  type MotionContext,
  type MotionPlan,
  type ActionPoint,
} from "./motion";
import type { SceneAction } from "./sceneMotion";

export interface BoundAction {
  id: string;
  name: string;
  actorActionId: string;
  actorActionUpdatedAt: number;
  /** Actor input -> scene point ID. No animation or plan is stored in Play. */
  bindings: Record<string, string>;
}
export interface ActionInput {
  id: string;
  name: string;
  preview: Vec3 | null;
}
function targets(
  plan: MotionPlan,
  visit: (target: Target, key: string) => Target,
): MotionPlan {
  const copy = structuredClone(plan);
  delete copy.start; // Only Play determines scene placement; actor preview start never teleports an instance.
  for (const step of copy.steps) {
    if (step.type === "moveTo") {
      step.destination = visit(step.destination, `${step.id}:destination`);
      if (step.path?.via)
        step.path.via = step.path.via.map((t, index) =>
          visit(t, `${step.id}:via:${index}`),
        );
    } else if (step.type === "turnTo" && step.target)
      step.target = visit(step.target, `${step.id}:facing`);
  }
  return copy;
}
function input(
  target: Target,
  key: string,
  action: SavedAction,
): ActionInput | null {
  if (Array.isArray(target))
    return {
      id: "position:" + key,
      name: "位置 · " + key,
      preview: [...target],
    };
  if ("point" in target) {
    const p = action.points?.find((p) => p.id === target.point);
    return {
      id: "point:" + target.point,
      name: p?.name ?? target.point,
      preview: p?.ground ? pointPosition(p) : null,
    };
  }
  if ("parameter" in target)
    return {
      id: "parameter:" + target.parameter,
      name: target.parameter,
      preview: action.plan.parameters?.[target.parameter]?.default ?? null,
    };
  return null;
}
export function actionInputs(action: SavedAction): ActionInput[] {
  const found = new Map<string, ActionInput>();
  targets(action.plan, (target, key) => {
    const slot = input(target, key, action);
    if (slot) found.set(slot.id, slot);
    return target;
  });
  return [...found.values()];
}
export function actorAction(
  actor: Actor,
  binding: BoundAction,
  revision: string,
  strict = true,
): SavedAction {
  const source = actor.motionActions?.find(
    (a) => a.id === binding.actorActionId,
  );
  if (!source)
    throw new MotionError(
      "ACTION_NOT_FOUND",
      "演员动作不存在，请重新选择演员层动作",
    );
  if (
    source.modelRevisionId !== revision ||
    source.plan.modelRevisionId !== revision
  )
    throw new MotionError("MODEL_MISMATCH", "演员动作与实例模型版本不匹配");
  if (strict && source.updatedAt !== binding.actorActionUpdatedAt)
    throw new MotionError(
      "STALE_ACTION",
      "演员动作已修改，请更新动作引用并检查地图绑定",
    );
  return source;
}
export function resolveBoundAction(
  actor: Actor,
  binding: BoundAction,
  ctx: MotionContext,
  strict = true,
): MotionPlan {
  const source = actorAction(actor, binding, ctx.modelRevisionId!, strict);
  const inputs = actionInputs(source);
  if (
    !binding.bindings ||
    typeof binding.bindings !== "object" ||
    Array.isArray(binding.bindings) ||
    Object.entries(binding.bindings).some(
      ([k, v]) =>
        typeof v !== "string" ||
        !ctx.points?.some((p) => p.id === v) ||
        ((strict || source.updatedAt === binding.actorActionUpdatedAt) &&
          !inputs.some((s) => s.id === k)),
    )
  )
    throw new Error("动作地图绑定字段无效，请更新动作引用");
  const plan = targets(source.plan, (target, key) => {
    const slot = input(target, key, source);
    if (!slot) return target;
    const id = Object.hasOwn(binding.bindings, slot.id)
      ? binding.bindings[slot.id]
      : undefined;
    if (id === undefined && !strict) return { context: "actionStartPosition" };
    if (!id || !ctx.points?.some((p) => p.id === id))
      throw new MotionError(
        "UNBOUND_INPUT",
        `请为动作输入 ${slot.name} 绑定地图点`,
      );
    return { point: id };
  });
  delete plan.parameters;
  const pool = (actor.pools ?? actor.actions)?.find(
    (p) => p.id === plan.poolId,
  );
  for (const step of plan.steps)
    if (step.type === "moveTo" || step.type === "playClip")
      for (const use of [
        ...(step.animation ? [step.animation] : []),
        ...(step.layers ?? []),
      ]) {
        const resolved = resolveClip(use, {
          actor,
          modelRevisionId: ctx.modelRevisionId,
          pool: plan.schemaVersion === 1 ? pool : undefined,
        });
        Object.assign(use, {
          clipId: resolved.clip.id,
          start: resolved.start,
          end: resolved.end,
          rate: resolved.rate,
          repeat: resolved.repeat,
        });
        delete use.slot;
        delete use.segment;
      }
  plan.schemaVersion = 2;
  delete plan.poolId;
  return validateAction(plan, ctx);
}
/** Explicit migration only; callers save the returned actor action before replacing a scene plan. */
export function promoteLegacyAction(
  legacy: SceneAction,
  scenePoints: ActionPoint[],
) {
  const source: SavedAction = {
    id: "legacy-" + legacy.id,
    name: legacy.name,
    createdAt: 0,
    updatedAt: 0,
    modelRevisionId: legacy.plan.modelRevisionId,
    prompt: "由旧演出迁入演员层；预览点在 Play 中重新绑定。",
    plan: legacy.plan,
    points: scenePoints,
  };
  const slots = actionInputs(source),
    previews: ActionPoint[] = [],
    bindings: Record<string, string> = {},
    mapping = new Map<string, string>();
  const points = structuredClone(scenePoints);
  const factor = Math.min(
    1,
    40 /
      Math.max(
        1,
        ...slots.flatMap((slot) =>
          slot.preview
            ? [Math.abs(slot.preview[0]), Math.abs(slot.preview[2])]
            : [],
        ),
      ),
  );
  for (const slot of slots) {
    let scenePoint = slot.id.startsWith("point:")
      ? points.find((p) => p.id === slot.id.slice(6))
      : undefined;
    if (!scenePoint) {
      if (!slot.preview) throw new Error("旧动作的位置参数未指定，无法迁移");
      let n = 1;
      while (points.some((p) => p.name === "p" + n)) n++;
      scenePoint = {
        id: crypto.randomUUID(),
        name: "p" + n,
        ground: [...slot.preview],
        height: 0,
      };
      points.push(scenePoint);
    }
    const id = crypto.randomUUID(),
      position = slot.preview;
    previews.push({
      id,
      name: "p" + (previews.length + 1),
      ground: position
        ? [position[0] * factor, 0, position[2] * factor]
        : [previews.length * 2, 0, 0],
      height: 0,
    });
    mapping.set(slot.id, id);
    bindings["point:" + id] = scenePoint.id;
  }
  source.plan = targets(source.plan, (target, key) => {
    const slot = input(target, key, source);
    return slot ? { point: mapping.get(slot.id)! } : target;
  });
  source.points = previews;
  return {
    source,
    points,
    binding: {
      id: legacy.id,
      name: legacy.name,
      actorActionId: source.id,
      actorActionUpdatedAt: 0,
      bindings,
    } as BoundAction,
  };
}
