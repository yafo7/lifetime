import { Euler, Quaternion, Vector3 } from "three";
import type { AnimationClip } from "../../shared/contracts";
import type { BuiltModelGroup, MotionPlan } from "./map/client/modelRenderer";

/** Every sample starts from rest; seeking and independent instances cannot accumulate motion. */
export type Pose = Map<string, { p: Vector3; q: Quaternion; s: Vector3 }>;
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
  capture(): Pose {
    return new Map(
      [...this.built.objects].map(([id, o]) => [
        id,
        { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() },
      ]),
    );
  }
  apply(pose: Pose): void {
    for (const [id, p] of pose) {
      const o = this.built.objects.get(id)!;
      o.position.copy(p.p);
      o.quaternion.copy(p.q);
      o.scale.copy(p.s);
    }
  }
  pose(
    clip: AnimationClip | null,
    seconds: number,
    rootHeight?: "animation" | "path",
  ): Pose {
    this.sample(clip, seconds);
    const pose = this.capture();
    if (rootHeight)
      for (const [id, o] of this.built.objects) {
        if (o.parent !== this.built.group) continue;
        const p = pose.get(id)!,
          rest = this.rest.get(id)!;
        p.p.x = rest.p.x;
        p.p.z = rest.p.z;
        if (rootHeight === "path") p.p.y = rest.p.y;
      }
    this.apply(this.rest);
    return pose;
  }
  blend(
    base: Pose,
    layer: Pose,
    weight: number,
    nodes?: string[],
    additive = false,
  ): Pose {
    const result: Pose = new Map();
    for (const [id, b] of base) {
      const p = { p: b.p.clone(), q: b.q.clone(), s: b.s.clone() },
        l = layer.get(id)!;
      let masked = !nodes;
      let o: import("three").Object3D | null = this.built.objects.get(id)!;
      while (o && !masked) {
        if (nodes!.some((n) => this.built.objects.get(n) === o)) masked = true;
        o = o.parent;
      }
      if (masked) {
        if (additive) {
          const rest = this.rest.get(id)!;
          p.p.addScaledVector(l.p.clone().sub(rest.p), weight);
          const delta = rest.q.clone().invert().multiply(l.q);
          p.q.multiply(new Quaternion().slerp(delta, weight)).normalize();
        } else {
          p.p.lerp(l.p, weight);
          p.q.slerp(l.q, weight);
          p.s.lerp(l.s, weight);
        }
      }
      result.set(id, p);
    }
    return result;
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
    const frame = Math.floor(time * baked.fps);
    const alpha = time * baked.fps - frame;
    for (const [id, tracks] of Object.entries(baked.animation)) {
      const o = this.built.objects.get(id);
      if (!o) continue;
      const value = (k: string, fallback = 0) => {
        const values = tracks[k];
        if (!values) return fallback;
        const a = values[Math.min(frame, values.length - 1)],
          b = values[Math.min(frame + 1, values.length - 1)];
        return a + (b - a) * alpha;
      };
      o.position.add(new Vector3(value("posX"), value("posY"), value("posZ")));
      if (tracks.quatX) {
        const quaternion = (index: number) =>
          new Quaternion(
            ...(["quatX", "quatY", "quatZ", "quatW"].map(
              (k) => tracks[k][Math.min(index, tracks[k].length - 1)],
            ) as [number, number, number, number]),
          ).normalize();
        o.quaternion.copy(
          quaternion(frame).slerp(quaternion(frame + 1), alpha),
        );
      } else {
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
