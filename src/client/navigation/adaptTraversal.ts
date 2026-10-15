import {
  pointPosition,
  type MotionContext,
  type MotionPlan,
  type MotionStep,
  type Target,
  type Vec3,
} from "../../shared/motion";
import { traversalClip, type TraversalKind } from "../../shared/traversal";
import type { TraversalPlanner } from "./traversalPlanner";

/** Derived execution plan only. Saved actor actions and map bindings remain untouched. */
export function adaptTraversal(
  plan: MotionPlan,
  ctx: MotionContext,
  origin: Vec3,
  planner: TraversalPlanner,
) {
  const adapted = structuredClone(plan),
    required = new Set<TraversalKind>(),
    missing = new Set<TraversalKind>();
  const position = (target: Target): Vec3 =>
    Array.isArray(target)
      ? target
      : "point" in target
        ? pointPosition(ctx.points!.find((p) => p.id === target.point)!)
        : "parameter" in target
          ? plan.parameters![target.parameter].default!
          : origin;
  let from = origin,
    sequence = 0;
  adapted.steps = plan.steps.flatMap<MotionStep>((step) => {
    if (step.type !== "moveTo") {
      if (step.type === "playClip") planner.assertStationary(from);
      return [structuredClone(step)];
    }
    const destinations = [...(step.path?.via ?? []), step.destination].map(
      position,
    );
    const legs = destinations.flatMap((target) => {
      const result = planner.route(from, target, step.path?.mode === "air");
      from = result.at(-1)!.points.at(-1)!;
      return result;
    });
    if (legs.every((leg) => leg.kind === "ground") && step.path?.mode !== "air")
      return [structuredClone(step)];
    return legs.map((leg, index) => {
      const copy = structuredClone(step);
      copy.id = `nav-${sequence++}-${step.id.slice(0, 70)}`;
      copy.destination = leg.points.at(-1)!;
      // Ground polyline is recalculated by the same proven NavMesh corridor at compilation.
      copy.path =
        leg.kind === "ground"
          ? { mode: "ground" }
          : {
              mode: "air",
              via: leg.points.slice(1, -1),
              ...(leg.arc ? { height: leg.arc } : {}),
            };
      if (index !== legs.length - 1) {
        delete copy.finalHeading;
        delete copy.markers;
      }
      if (leg.kind !== "ground") {
        required.add(leg.kind);
        const clip = traversalClip(ctx.actor, ctx.modelRevisionId!, leg.kind);
        if (!clip) missing.add(leg.kind);
        copy.animation = clip
          ? {
              clipId: clip.id,
              rate: 1,
              repeat: leg.kind === "jump" ? 1 : "untilArrival",
            }
          : null;
        copy.layers = [];
        copy.rootHeight = "path";
        copy.sync = clip && leg.kind === "jump" ? "fitClip" : "independent";
      }
      return copy;
    });
  });
  return { plan: adapted, required: [...required], missing: [...missing] };
}
