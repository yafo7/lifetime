import type { Actor } from "../../shared/contracts";
import type { SceneActionIntent } from "../../shared/scenePlan";
import {
  validateAction,
  type ActionPoint,
  type SavedAction,
  type MotionStep,
  type PromptPart,
} from "../../shared/motion";
import type { ResolvedLocation } from "../navigation/locationResolver";

/** Produces an actor-owned action with preview inputs plus explicit map bindings. */
export function compileSceneAction(
  intent: SceneActionIntent,
  actor: Actor,
  revision: string,
  locations: Map<string, ResolvedLocation>,
) {
  const points: ActionPoint[] = [],
    bindings: Record<string, string> = {},
    inputs = new Map<string, string>(),
    steps: MotionStep[] = [],
    clips = new Set<string>();
  const target = (mapPoint: ActionPoint) => {
    let id = inputs.get(mapPoint.id);
    if (!id) {
      id = crypto.randomUUID();
      inputs.set(mapPoint.id, id);
      const n = points.length;
      points.push({
        id,
        name: "p" + (n + 1),
        ground: [(n % 4) * 4, 0, Math.floor(n / 4) * 4],
        height: 0,
      });
      bindings["point:" + id] = mapPoint.id;
    }
    return { point: id };
  };
  const get = (key: string) => {
    const l = locations.get(key);
    if (!l) throw new Error("动作引用未知位置意图");
    return l;
  };
  for (const step of intent.steps) {
    if (step.type === "moveTo" || step.type === "followRoute") {
      clips.add(step.animation);
      const location = get(step.type === "moveTo" ? step.target : step.route);
      const sequence =
        step.type === "moveTo"
          ? [location.points[0]]
          : [
              ...location.points,
              ...(location.closed ? [location.points[0]] : []),
            ];
      for (const p of sequence)
        steps.push({
          id: crypto.randomUUID(),
          type: "moveTo",
          destination: target(p),
          speed: step.speed,
          path: { mode: "ground" },
          sync: "independent",
          animation: {
            clipId: step.animation,
            rate: step.rate,
            repeat: "untilArrival",
          },
          transition: 0.12,
        });
    } else if (step.type === "playClip") {
      clips.add(step.animation);
      steps.push({
        id: crypto.randomUUID(),
        type: "playClip",
        animation: {
          clipId: step.animation,
          rate: step.rate,
          repeat: step.repetitions,
        },
        transition: 0.12,
      });
    } else if (step.type === "face")
      steps.push({
        id: crypto.randomUUID(),
        type: "turnTo",
        target: target(get(step.target).points[0]),
        speed: 180,
      });
    else
      steps.push({
        id: crypto.randomUUID(),
        type: "wait",
        seconds: step.seconds,
      });
  }
  const document: PromptPart[] = [{ type: "text", text: intent.name + "。" }];
  for (const p of points)
    document.push(
      { type: "point", pointId: p.id },
      { type: "text", text: " " },
    );
  for (const id of clips)
    document.push(
      { type: "animation", clipId: id, modelRevisionId: revision },
      { type: "text", text: " " },
    );
  const plan = validateAction(
    { schemaVersion: 2, name: intent.name, modelRevisionId: revision, steps },
    { actor, modelRevisionId: revision, points },
  );
  const action: SavedAction = {
    id: crypto.randomUUID(),
    name: intent.name,
    modelRevisionId: revision,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    prompt: intent.name,
    document,
    points,
    plan,
  };
  return { action, bindings };
}
