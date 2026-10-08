import * as THREE from "three";
import type { Actor, ActorInstance } from "../../shared/contracts";
import type { EditableMap } from "../../shared/maps";
import { MotionError } from "../../shared/motion";
import { getMapCollisionBake } from "../rendering/map/shared/map";
import { buildModelGroupWithNodes } from "../rendering/map/client/modelRenderer";
import { AnimationPlayer } from "../rendering/animationPlayer";
import { motionPose } from "../rendering/motionPose";
import type { MotionRuntime, ActionTiming } from "../motion/runtime";

/** Conservative sampled bounds, not a physics solver or an animation retargeter. */
export async function checkStationaryClearance(
  actor: Actor,
  instance: ActorInstance,
  map: EditableMap,
  runtime: MotionRuntime,
  timings: ActionTiming[],
) {
  if (!timings.some((t) => t.type === "playClip")) return;
  const built = await buildModelGroupWithNodes(
    actor.modelRevisions.find((r) => r.id === instance.modelRevisionId)!
      .modelJson,
    { fidelity: true },
  );
  const player = new AnimationPlayer(built),
    root = new THREE.Group(),
    rest = new THREE.Box3().setFromObject(built.group),
    center = rest.getCenter(new THREE.Vector3());
  built.group.position.set(-center.x, -rest.min.y, -center.z);
  root.scale.setScalar(instance.scale);
  root.add(built.group);
  const solids = getMapCollisionBake(map),
    box = new THREE.Box3();
  const state = runtime.getExecutionState()!;
  runtime.resumeExecution(state.executionId);
  try {
    for (const t of timings.filter((t) => t.type === "playClip")) {
      const samples = Math.max(1, Math.min(1200, Math.ceil(t.duration * 15)));
      for (let k = 0; k <= samples; k++) {
        const time = Math.min(
          t.end - 1e-7,
          t.start + (t.duration * k) / samples,
        );
        runtime.advance(
          Math.max(0, time - runtime.getExecutionState()!.elapsed),
        );
        const frame = runtime.frame!;
        player.apply(motionPose(player, frame));
        root.position.fromArray(frame.position);
        root.rotation.y = frame.heading;
        root.updateMatrixWorld(true);
        box.setFromObject(root);
        const ids = new Set(solids.cells["*"] ?? []);
        for (
          let z = Math.floor(box.min.z / solids.cellSize);
          z <= Math.floor(box.max.z / solids.cellSize);
          z++
        )
          for (
            let x = Math.floor(box.min.x / solids.cellSize);
            x <= Math.floor(box.max.x / solids.cellSize);
            x++
          )
            for (const id of solids.cells[`${x},${z}`] ?? []) ids.add(id);
        const blocked = [...ids].some((id) => {
          const b = solids.boxes[id];
          return (
            b.max[1] >
              frame.position[1] +
                instance.sceneMotion!.navigation.climb +
                0.025 &&
            b.min[0] < box.max.x - 0.025 &&
            b.max[0] > box.min.x + 0.025 &&
            b.min[2] < box.max.z - 0.025 &&
            b.max[2] > box.min.z + 0.025 &&
            b.min[1] < box.max.y - 0.025 &&
            b.max[1] > box.min.y + 0.025
          );
        });
        if (
          blocked ||
          box.min.x < -map.box.size[0] / 2 ||
          box.max.x > map.box.size[0] / 2 ||
          box.min.z < -map.box.size[2] / 2 ||
          box.max.z > map.box.size[2] / 2
        )
          throw new MotionError(
            "ACTION_SPACE_BLOCKED",
            "原地动画需要更多空间，请把表演点移离障碍或边缘",
          );
      }
    }
  } finally {
    runtime.reset();
    const geometries = new Set<THREE.BufferGeometry>(),
      materials = new Set<THREE.Material>();
    root.traverse((n) => {
      const m = n as THREE.Mesh;
      if (m.isMesh) {
        geometries.add(m.geometry);
        (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) =>
          materials.add(x),
        );
      }
    });
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
  }
}
