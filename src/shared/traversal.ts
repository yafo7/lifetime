import type { Actor, AnimationClip } from "./contracts";

export type TraversalKind = "jump" | "fly";
export interface TraversalPolicy {
  /** Ground + bounded jumps is the default; flight is an explicit character ability. */
  fly: boolean;
  jumpHeight?: number;
  jumpDistance?: number;
}
export const traversalAnimation = {
  jump: {
    name: "导航跳跃",
    description:
      "jump once in place, crouch, leap and land steadily; no horizontal translation; non-looping",
    loop: false,
  },
  fly: {
    name: "导航飞行",
    description:
      "flying cycle, flap wings steadily in place and hover; no root translation; seamless looping",
    loop: true,
  },
} as const;
export function traversalClip(
  actor: Actor,
  revision: string,
  kind: TraversalKind,
): AnimationClip | undefined {
  return actor.animations
    .filter(
      (c) =>
        c.modelRevisionId === revision &&
        (kind !== "fly" || !!(c.animation as { loop?: boolean })?.loop) &&
        ((c.metadata as { lifetimeTraversal?: string } | undefined)
          ?.lifetimeTraversal === kind ||
          (kind === "jump"
            ? /跳跃|\bjump\b/i
            : /飞行|扇翼|\bfly(?:ing)?\b|\bflight\b/i
          ).test(c.name)),
    )
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}
