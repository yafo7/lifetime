import type {
  Actor,
  AnimationClip,
  ModelRevision,
} from "../../shared/contracts";

export interface PlayerAssets {
  actor: Actor;
  model: ModelRevision;
  run: AnimationClip;
  jump: AnimationClip;
}
/** Resolve library references; entering the map never generates or duplicates resources. */
export function playerAssets(actors: Actor[]): PlayerAssets {
  const candidates = actors
    .filter((a) => /钢铁侠/.test(a.name))
    .sort(
      (a, b) =>
        Number(b.name === "红金钢铁侠装甲鸭") -
        Number(a.name === "红金钢铁侠装甲鸭"),
    );
  for (const actor of candidates) {
    for (const model of [...actor.modelRevisions].sort(
      (a, b) => b.createdAt - a.createdAt,
    )) {
      const clips = actor.animations
        .filter((c) => c.modelRevisionId === model.id)
        .sort((a, b) => b.createdAt - a.createdAt);
      const run = clips.find((c) => /奔跑|跑步|running|run\b/i.test(c.name));
      const jump =
        clips.find((c) => /玩家.*跳跃/.test(c.name)) ??
        clips.find((c) => /跳跃|jump\b/i.test(c.name));
      if (run && jump) return { actor, model, run, jump };
    }
  }
  throw new Error(
    "请在演员库中准备钢铁侠鸭子的模型，以及同一模型版本的奔跑、跳跃动画",
  );
}
