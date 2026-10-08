import type { Actor } from "./contracts";
import {
  validateAction,
  type ActionPoint,
  type MotionPlan,
  type MotionStep,
  type PromptPart,
} from "./motion";

export type ActionTemplate = "route" | "visit" | "stationary";
/** Local actor authoring, using existing assets only. Scene geometry is never involved. */
export function createActionTemplate(
  actor: Actor,
  revision: string,
  kind: ActionTemplate,
  movementId: string,
  performances: string[],
  existing: ActionPoint[] = [],
) {
  const clip = (id: string) => {
    const c = actor.animations.find(
      (c) => c.id === id && c.modelRevisionId === revision,
    );
    if (!c) throw new Error("请选择当前模型版本的动画");
    return c;
  };
  const size = kind === "route" ? 4 : kind === "visit" ? 3 : 0;
  const points: ActionPoint[] =
    existing.length >= (kind === "route" ? 2 : size) && kind !== "stationary"
      ? structuredClone(kind === "visit" ? existing.slice(0, 3) : existing)
      : Array.from({ length: size }, (_, i) => ({
          id: crypto.randomUUID(),
          name: "p" + (i + 1),
          ground: (kind === "route"
            ? [
                [0, 0, -10],
                [10, 0, 0],
                [0, 0, 10],
                [-10, 0, 0],
              ]
            : [
                [0, 0, 10],
                [10, 0, 10],
                [0, 0, 0],
              ])[i] as [number, number, number],
          height: 0,
        }));
  if (points.some((p) => !p.ground || p.height || p.ground[1]))
    throw new Error("基础模板请使用已放置的地面预览点");
  let movement: ReturnType<typeof clip> | null = null;
  if (kind !== "stationary") movement = clip(movementId);
  if (kind !== "route" && !performances.length)
    throw new Error("请添加至少一个表演动画");
  const steps: MotionStep[] = [];
  const move = (point: ActionPoint) => {
    const loop = Boolean((movement!.animation as { loop?: boolean }).loop);
    steps.push({
      id: crypto.randomUUID(),
      type: "moveTo",
      destination: { point: point.id },
      speed: 3,
      path: { mode: "ground" },
      sync: loop ? "independent" : "fitClip",
      animation: {
        clipId: movement!.id,
        rate: 1,
        repeat: loop ? "untilArrival" : 1,
      },
    });
  };
  if (kind === "route") {
    for (const p of points) move(p);
    move(points[0]);
  } else {
    if (kind === "visit") {
      move(points[0]);
      steps.push({
        id: crypto.randomUUID(),
        type: "turnTo",
        target: { point: points[1].id },
        speed: 180,
      });
    }
    for (const id of performances) {
      clip(id);
      steps.push({
        id: crypto.randomUUID(),
        type: "playClip",
        animation: { clipId: id, rate: 1, repeat: 1 },
      });
    }
    if (kind === "visit") move(points[2]);
  }
  const name =
    kind === "route"
      ? "沿路线跑步"
      : kind === "visit"
        ? "前往表演并返回"
        : "原地表演";
  const document: PromptPart[] = [
    {
      type: "text",
      text:
        kind === "route"
          ? "依次经过以下标点并返回路线入口："
          : kind === "visit"
            ? "p1 为表演点，p2 为朝向目标，p3 为返回点。依次播放所选动画后返回。"
            : "按顺序原地播放所选动画。",
    },
  ];
  for (const p of points)
    document.push(
      { type: "point", pointId: p.id },
      { type: "text", text: " " },
    );
  for (const id of new Set([
    ...(movement ? [movement.id] : []),
    ...performances,
  ]))
    document.push(
      { type: "animation", clipId: id, modelRevisionId: revision },
      { type: "text", text: " " },
    );
  const plan: MotionPlan = {
    schemaVersion: 2,
    name,
    modelRevisionId: revision,
    ...(kind === "route" ? { start: { point: points[0].id } } : {}),
    steps,
  };
  validateAction(plan, { actor, modelRevisionId: revision, points });
  return { points, plan, document };
}
