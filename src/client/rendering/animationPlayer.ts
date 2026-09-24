import { Euler, Vector3 } from "three";
import type { AnimationClip } from "../../shared/contracts";
import type { BuiltModelGroup, MotionPlan } from "./map/client/modelRenderer";

/** Every sample starts from rest; seeking and independent instances cannot accumulate motion. */
export class AnimationPlayer {
  private rest;
  constructor(private built: BuiltModelGroup) {
    this.rest = new Map(
      [...built.objects].map(([id, o]) => [
        id,
        { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() },
      ]),
    );
  }
  sample(clip: AnimationClip | null, seconds: number): void {
    for (const [id, rest] of this.rest) {
      const o = this.built.objects.get(id)!;
      o.position.copy(rest.p);
      o.quaternion.copy(rest.q);
      o.scale.copy(rest.s);
    }
    if (!clip) return;
    const time = Math.max(0, Math.min(seconds, clip.duration));
    if (clip.format === "plan") {
      const deltas = this.built.runtime.evaluateMotion(
        clip.animation as MotionPlan,
        clip.duration,
        time,
        this.built.motionLookups,
      );
      for (const [id, d] of Object.entries(deltas)) {
        const o = this.built.objects.get(id);
        if (!o) continue;
        if (d.position) o.position.add(new Vector3(...d.position));
        if (d.rotation)
          o.rotation.set(
            o.rotation.x + d.rotation[0],
            o.rotation.y + d.rotation[1],
            o.rotation.z + d.rotation[2],
          );
        if (d.scale) o.scale.multiply(new Vector3(...d.scale));
      }
      return;
    }
    const baked = clip.animation as {
      fps: number;
      animation: Record<string, Record<string, number[]>>;
    };
    const frame = Math.round(time * baked.fps);
    for (const [id, tracks] of Object.entries(baked.animation)) {
      const o = this.built.objects.get(id);
      if (!o) continue;
      const value = (k: string, fallback = 0) =>
        tracks[k]?.[Math.min(frame, tracks[k].length - 1)] ?? fallback;
      o.position.add(new Vector3(value("posX"), value("posY"), value("posZ")));
      if (tracks.quatX)
        o.quaternion
          .set(
            value("quatX"),
            value("quatY"),
            value("quatZ"),
            value("quatW", 1),
          )
          .normalize();
      else {
        const e = new Euler().setFromQuaternion(o.quaternion);
        o.rotation.set(
          e.x + value("rotX"),
          e.y + value("rotY"),
          e.z + value("rotZ"),
        );
      }
    }
  }
}
