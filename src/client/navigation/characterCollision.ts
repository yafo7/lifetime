import type { Actor, ActorInstance } from "../../shared/contracts";
import type { Vec3 } from "../../shared/motion";
import { calculateModelVisualBounds } from "../rendering/map/shared/modelBounds";

/** Upright cylinders at character feet; animation limbs are not rigid bodies. */
export interface CharacterBody {
  id: string;
  position: Vec3;
  radius: number;
  height: number;
}
export const characterGap = 0.12;
export function characterBody(
  instance: ActorInstance,
  actor?: Actor,
  position: Vec3 = instance.position,
): CharacterBody {
  const profile = instance.sceneMotion?.navigation;
  if (profile)
    return {
      id: instance.id,
      position,
      radius: profile.radius,
      height: profile.height,
    };
  const model = actor?.modelRevisions.find(
    (m) => m.id === instance.modelRevisionId,
  );
  if (!model) throw new Error("碰撞检查缺少角色模型版本");
  const bounds = calculateModelVisualBounds(model.modelJson);
  return {
    id: instance.id,
    position,
    radius: Math.max(
      0.05,
      (Math.hypot(
        bounds.max[0] - bounds.min[0],
        bounds.max[2] - bounds.min[2],
      ) *
        instance.scale) /
        2,
    ),
    height: Math.max(0.1, (bounds.max[1] - bounds.min[1]) * instance.scale),
  };
}
export function bodiesOverlap(
  a: CharacterBody,
  b: CharacterBody,
  gap = characterGap,
): boolean {
  return (
    a.id !== b.id &&
    a.position[1] < b.position[1] + b.height - 0.01 &&
    a.position[1] + a.height > b.position[1] + 0.01 &&
    Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]) <
      a.radius + b.radius + gap - 1e-6
  );
}

/** Swept cylinder test: intersect the vertical-overlap interval with horizontal motion.
 * Existing overlaps may escape monotonically, so legacy scenes are not permanently locked.
 */
export function canMoveBody(
  body: CharacterBody,
  to: Vec3,
  others: Iterable<CharacterBody>,
): boolean {
  const from = body.position;
  for (const other of others) {
    if (other.id === body.id) continue;
    let low = 0,
      high = 1;
    const dy = to[1] - from[1],
      bottom = other.position[1] - body.height + 0.01,
      top = other.position[1] + other.height - 0.01;
    if (Math.abs(dy) < 1e-9) {
      if (from[1] <= bottom || from[1] >= top) continue;
    } else {
      const a = (bottom - from[1]) / dy,
        b = (top - from[1]) / dy;
      low = Math.max(low, Math.min(a, b));
      high = Math.min(high, Math.max(a, b));
      if (low >= high) continue;
    }
    const x = from[0] - other.position[0],
      z = from[2] - other.position[2],
      dx = to[0] - from[0],
      dz = to[2] - from[2],
      d2 = dx * dx + dz * dz,
      t = Math.max(low, Math.min(high, d2 ? -(x * dx + z * dz) / d2 : low)),
      radius = body.radius + other.radius + characterGap;
    if ((x + t * dx) ** 2 + (z + t * dz) ** 2 >= radius * radius - 1e-6)
      continue;
    const end2 = (x + dx) ** 2 + (z + dz) ** 2;
    if (
      bodiesOverlap(body, other) &&
      ((end2 > x * x + z * z + 1e-8 && x * dx + z * dz >= -1e-8) ||
        (d2 < 1e-10 &&
          Math.abs(to[1] - other.position[1]) >
            Math.abs(from[1] - other.position[1]) + 1e-8))
    )
      continue;
    // Stationary animations can continue even in a legacy overlap.
    if (Math.hypot(dx, dy, dz) < 1e-9) continue;
    return false;
  }
  return true;
}
