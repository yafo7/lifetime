import type { MotionFrame } from "../motion/runtime";
import type { AnimationPlayer, Pose } from "./animationPlayer";

/** Shared sampling for visible playback and local action-space validation. */
export function motionPose(player: AnimationPlayer, frame: MotionFrame): Pose {
  const rootHeight = frame.preserveRoot ? undefined : frame.rootHeight;
  let pose = player.pose(
    frame.animation?.clip.clip ?? null,
    frame.animation?.time ?? 0,
    rootHeight,
  );
  const primary = frame.animation?.clip.use;
  if (
    primary &&
    (primary.nodes ||
      primary.weight !== undefined ||
      primary.blend === "additive")
  )
    pose = player.blend(
      player.pose(null, 0, rootHeight),
      pose,
      primary.weight ?? 1,
      primary.nodes,
      primary.blend === "additive",
    );
  for (const layer of frame.layers)
    pose = player.blend(
      pose,
      player.pose(layer.clip.clip, layer.time, rootHeight),
      layer.weight,
      layer.clip.use.nodes,
      layer.clip.use.blend === "additive",
    );
  return pose;
}
