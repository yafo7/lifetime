import * as THREE from "three";
import { create } from "../../vendor/voxel-motion-runtime/module.js";
import type { AnimationClip } from "./contracts";

export function decodeAnimation(
  payload: { baked?: unknown; plan?: unknown },
  model: unknown,
): Pick<AnimationClip, "format" | "animation" | "duration"> {
  const ids = new Set(
    (model as { nodes?: { id: string }[] })?.nodes?.map((n) => n.id),
  );
  const baked = payload.baked as
    | {
        duration: number;
        fps: number;
        animation: Record<string, Record<string, number[]>>;
        emit?: unknown;
        vfx?: unknown;
      }
    | undefined;
  if (baked) {
    if (
      !Number.isFinite(baked.duration) ||
      baked.duration <= 0 ||
      !Number.isFinite(baked.fps) ||
      baked.fps <= 0 ||
      !baked.animation ||
      !Object.keys(baked.animation).length
    )
      throw new Error("动画缺少有效时长或轨道");
    if (
      (baked.emit && Object.keys(baked.emit).length) ||
      (baked.vfx &&
        Object.values(baked.vfx).some((value) =>
          Array.isArray(value) ? value.length > 0 : Boolean(value),
        ))
    )
      throw new Error("此动画包含尚未支持的粒子或 VFX，请关闭特效后生成");
    for (const [id, tracks] of Object.entries(baked.animation)) {
      if (!ids.has(id)) throw new Error(`动画引用不存在的模型节点：${id}`);
      if (!tracks || !Object.keys(tracks).length)
        throw new Error("动画轨道为空");
      let count: number | undefined;
      for (const [key, values] of Object.entries(tracks)) {
        if (!/^(pos[XYZ]|rot[XYZ]|quat[XYZW])$/.test(key))
          throw new Error(`不支持的动画轨道：${key}`);
        if (
          !Array.isArray(values) ||
          !values.length ||
          !values.every(Number.isFinite) ||
          (count !== undefined && count !== values.length)
        )
          throw new Error("动画轨道长度或数值无效");
        count = values.length;
      }
      if (
        Object.keys(tracks).some((k) => k.startsWith("quat")) &&
        ["quatX", "quatY", "quatZ", "quatW"].some((k) => !tracks[k])
      )
        throw new Error("动画四元数轨道不完整");
      if (tracks.quatX)
        for (let i = 0; i < tracks.quatX.length; i++) {
          if (
            ["quatX", "quatY", "quatZ", "quatW"].reduce(
              (sum, key) => sum + tracks[key][i] ** 2,
              0,
            ) < 1e-12
          )
            throw new Error("动画包含零四元数");
        }
    }
    return { format: "baked", animation: baked, duration: baked.duration };
  }
  const plan = payload.plan as { _duration?: number } | undefined;
  if (plan && Number.isFinite(plan._duration) && plan._duration! > 0) {
    const keys = Object.keys(plan).filter((k) => !k.startsWith("_"));
    if (!keys.length || keys.some((k) => !ids.has(k)))
      throw new Error("旧版动画未绑定有效模型节点");
    const available = new Set(
      create({ THREE })
        .listAnimationTemplates()
        .map((t) => t.key),
    );
    for (const id of keys) {
      const tracks = (plan as Record<string, unknown>)[id];
      if (!tracks || typeof tracks !== "object")
        throw new Error("旧版动画轨道无效");
      for (const key of Object.keys(tracks))
        if (
          !available.has(key) ||
          ["aimSeq", "sweep", "emit", "vfx", "_attach"].includes(key)
        )
          throw new Error(`尚不支持此动画模板：${key}`);
    }
    return { format: "plan", animation: plan, duration: plan._duration! };
  }
  throw new Error("响应缺少可播放动画");
}
