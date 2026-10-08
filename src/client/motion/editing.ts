import {
  resolveClip,
  validateAction,
  validateDocument,
  validateAnimationReferences,
  requireMotion,
  type ClipUse,
  type MotionContext,
  type MotionPlan,
  type PromptPart,
} from "../../shared/motion";

export interface AnimationEdit {
  clipId: string;
  rate: number;
  start: number;
  end: number;
  repeat: number;
  sync?: "independent" | "fitClip";
  speed?: number;
}

/** Transactional draft edit. Geometry-dependent duration validation is done by the same runtime compiler. */
export function editAnimation(
  plan: MotionPlan,
  document: PromptPart[],
  ctx: MotionContext,
  stepId: string,
  layer: number,
  edit: AnimationEdit,
) {
  requireMotion(
    plan.schemaVersion === 2,
    "INVALID_SCHEMA",
    "旧版动作请重新生成后编辑片段",
  );
  const next = structuredClone(plan);
  const step = next.steps.find((s) => s.id === stepId);
  requireMotion(
    step && (step.type === "moveTo" || step.type === "playClip"),
    "INVALID_SEGMENT",
    "这个片段没有可编辑的动画",
  );
  requireMotion(
    Number.isInteger(layer) &&
      layer >= -1 &&
      (layer === -1 || !!step.layers?.[layer]),
    "INVALID_SEGMENT",
    "动画层不存在",
  );
  const old = layer === -1 ? step.animation : step.layers![layer];
  const oldId = old ? resolveClip(old, ctx).clip.id : undefined;
  const clip = ctx.actor.animations.find(
    (c) => c.id === edit.clipId && c.modelRevisionId === next.modelRevisionId,
  );
  requireMotion(clip, "MODEL_MISMATCH", "请选择当前模型版本的动画");
  const use: ClipUse = {
    ...old,
    clipId: clip.id,
    rate: edit.rate,
    start: edit.start,
    end: edit.end,
    repeat: edit.repeat,
  };
  delete use.slot;
  delete use.segment;
  if (layer === -1 && step.type === "moveTo") {
    step.sync = edit.sync ?? "independent";
    step.speed = edit.speed ?? step.speed;
    use.repeat =
      step.sync === "fitClip"
        ? 1
        : (clip.animation as { loop?: boolean })?.loop
          ? "untilArrival"
          : 1;
  }
  if (layer === -1) {
    step.animation = use;
    if (step.type === "playClip") delete step.seconds;
  } else step.layers![layer] = use;
  const valid = validateAction(next, ctx);
  const used = new Set(
    valid.steps.flatMap((s) =>
      s.type === "moveTo" || s.type === "playClip"
        ? [...(s.animation ? [s.animation] : []), ...(s.layers ?? [])].map(
            (c) => resolveClip(c, ctx).clip.id,
          )
        : [],
    ),
  );
  // Only replace a text token when the old animation is no longer used anywhere.
  // Other steps that still use it retain their explicit text reference.
  const doc = document.map((part) =>
    part.type === "animation" && part.clipId === oldId && !used.has(oldId)
      ? { ...part, clipId: clip.id, modelRevisionId: clip.modelRevisionId }
      : structuredClone(part),
  );
  validateDocument(doc, ctx.points ?? [], ctx);
  validateAnimationReferences(doc, valid, ctx);
  return { plan: valid, document: doc };
}

/** Removing a clip preserves the slot and spatial instruction. */
export function clearAnimation(
  plan: MotionPlan,
  document: PromptPart[],
  ctx: MotionContext,
  stepId: string,
  layer: number,
  duration: number,
) {
  requireMotion(
    plan.schemaVersion === 2,
    "INVALID_SCHEMA",
    "旧版动作请重新生成后编辑卡槽",
  );
  const next = structuredClone(plan);
  const step = next.steps.find((s) => s.id === stepId);
  requireMotion(
    step && (step.type === "moveTo" || step.type === "playClip"),
    "INVALID_SEGMENT",
    "这个卡槽没有动画",
  );
  requireMotion(
    Number.isInteger(layer) &&
      layer >= -1 &&
      (layer === -1 || !!step.layers?.[layer]),
    "INVALID_SEGMENT",
    "动画层不存在",
  );
  const old = layer === -1 ? step.animation : step.layers![layer];
  requireMotion(old, "INVALID_SEGMENT", "卡槽已经为空");
  const oldId = resolveClip(old, ctx).clip.id;
  if (layer >= 0) step.layers!.splice(layer, 1);
  else {
    step.animation = null;
    if (step.type === "playClip") step.seconds = duration;
    else {
      // Detach animation timing from movement; keep the declared movement speed.
      step.sync = "independent";
    }
  }
  const valid = validateAction(next, ctx);
  const used = valid.steps.some(
    (s) =>
      (s.type === "moveTo" || s.type === "playClip") &&
      [...(s.animation ? [s.animation] : []), ...(s.layers ?? [])].some(
        (c) => resolveClip(c, ctx).clip.id === oldId,
      ),
  );
  const doc = structuredClone(
    document.filter(
      (p) => p.type !== "animation" || p.clipId !== oldId || used,
    ),
  );
  validateDocument(doc, ctx.points ?? [], ctx);
  validateAnimationReferences(doc, valid, ctx);
  return { plan: valid, document: doc };
}

export function appendAnimation(
  plan: MotionPlan,
  document: PromptPart[],
  ctx: MotionContext,
  clipId: string,
  id: string,
) {
  requireMotion(
    plan.schemaVersion === 2,
    "INVALID_SCHEMA",
    "旧版动作请重新生成后编辑卡槽",
  );
  const next = structuredClone(plan);
  next.steps.push({
    id,
    type: "playClip",
    animation: { clipId, rate: 1, repeat: 1 },
  });
  const valid = validateAction(next, ctx);
  validateDocument(document, ctx.points ?? [], ctx);
  validateAnimationReferences(document, valid, ctx);
  return { plan: valid, document: structuredClone(document) };
}
