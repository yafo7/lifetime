import type { Actor, ActionPool, AnimationClip } from "./contracts";

export type Vec3 = [number, number, number];
export type Target =
  | Vec3
  | { point: string }
  | { parameter: string }
  | { context: "actionStartPosition" };
export interface Segment {
  name: string;
  start: number;
  end: number;
  loop: boolean;
}
export interface PoolEntry {
  slot: string;
  clipId: string;
  segments: Segment[];
  referenceSpeed?: number;
  minRate?: number;
  maxRate?: number;
}
export interface ClipUse {
  slot?: string;
  clipId?: string;
  segment?: string;
  start?: number;
  end?: number;
  rate?: number;
  repeat?: number | "untilArrival";
  nodes?: string[];
  weight?: number;
  blend?: "override" | "additive";
}
export interface StepBase {
  id: string;
  transition?: number;
  markers?: { name: string; at: number }[];
}
export type MotionStep = StepBase &
  (
    | {
        type: "moveTo";
        destination: Target;
        speed: number;
        path?: { mode: "ground" | "air"; via?: Target[]; height?: number };
        animation: ClipUse | null;
        layers?: ClipUse[];
        sync?: "independent" | "locomotion" | "fitClip";
        rootHeight?: "animation" | "path";
        finalHeading?: number;
      }
    | {
        type: "playClip";
        animation: ClipUse | null;
        seconds?: number;
        layers?: ClipUse[];
      }
    | { type: "turnTo"; heading?: number; target?: Target; speed: number }
    | { type: "wait"; seconds: number }
  );
export interface MotionPlan {
  schemaVersion: 1 | 2;
  name: string;
  modelRevisionId: string;
  poolId?: string;
  start?: Target;
  parameters?: Record<string, { type: "vec3"; default?: Vec3 }>;
  steps: MotionStep[];
}
export interface SavedAction {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  modelRevisionId: string;
  prompt: string;
  plan: MotionPlan;
  document?: PromptPart[];
  points?: ActionPoint[];
}
export interface MotionContext {
  actor: Actor;
  pool?: ActionPool;
  modelRevisionId?: string;
  points?: ActionPoint[];
  space?: MotionSpace;
  /** Draft scene authoring only. Execution still requires concrete coordinates. */
  allowUnplacedPoints?: boolean;
}
export interface MotionSpace {
  min: Vec3;
  max: Vec3;
}
export interface ActionPoint {
  id: string;
  name: string;
  ground: Vec3 | null;
  height: number;
  offsetMode?: "up" | "normal";
  surface?: SurfaceAnchor;
}
/** Serializable anchor plus a world-space snapshot; live resolution belongs to the renderer. */
export interface SurfaceAnchor {
  objectId: string;
  nodeId: string;
  localPosition: Vec3;
  localNormal: Vec3;
  position: Vec3;
  normal: Vec3;
}
export type PromptPart =
  | { type: "text"; text: string }
  | { type: "point"; pointId: string }
  | { type: "animation"; clipId: string; modelRevisionId: string };
export function revisionId(ctx: MotionContext): string {
  return ctx.modelRevisionId ?? ctx.pool?.modelRevisionId ?? "";
}
export function animationEntries(ctx: MotionContext): PoolEntry[] {
  if (ctx.pool) return poolEntries(ctx.pool, ctx.actor);
  return ctx.actor.animations
    .filter((c) => c.modelRevisionId === revisionId(ctx))
    .map((c) => ({
      slot: c.id,
      clipId: c.id,
      segments: [
        {
          name: "full",
          start: 0,
          end: c.duration,
          loop: Boolean((c.animation as { loop?: boolean })?.loop),
        },
      ],
    }));
}
export function validatePoints(
  points: unknown,
  space?: MotionSpace,
): asserts points is ActionPoint[] {
  requireMotion(
    Array.isArray(points) && points.length <= 20,
    "INVALID_TARGET",
    "最多设置 20 个标点",
  );
  const ids = new Set<string>(),
    names = new Set<string>();
  for (const p of points) {
    requireMotion(object(p), "INVALID_TARGET", "标点格式无效");
    keys(p, ["id", "name", "ground", "height", "offsetMode", "surface"]);
    requireMotion(
      typeof p.id === "string" &&
        /^[\w-]{1,100}$/.test(p.id) &&
        !ids.has(p.id) &&
        typeof p.name === "string" &&
        /^p[1-9]\d*$/.test(p.name) &&
        !names.has(p.name),
      "INVALID_TARGET",
      "标点名称或身份重复、无效",
    );
    ids.add(p.id);
    names.add(p.name);
    number(p.height, 0, space ? space.max[1] - space.min[1] : 100, "离地高度");
    requireMotion(
      p.offsetMode === undefined || ["up", "normal"].includes(p.offsetMode),
      "INVALID_TARGET",
      "偏移方向无效",
    );
    if (p.surface !== undefined) {
      const a = p.surface;
      requireMotion(
        object(a) && p.ground !== null,
        "INVALID_TARGET",
        "表面锚点无效",
      );
      keys(a, [
        "objectId",
        "nodeId",
        "localPosition",
        "localNormal",
        "position",
        "normal",
      ]);
      requireMotion(
        [a.objectId, a.nodeId].every(
          (v) => typeof v === "string" && v.length > 0 && v.length <= 1000,
        ),
        "INVALID_TARGET",
        "表面身份无效",
      );
      for (const v of [a.localPosition, a.localNormal, a.normal])
        requireMotion(
          Array.isArray(v) && v.length === 3 && v.every(Number.isFinite),
          "INVALID_TARGET",
          "表面坐标无效",
        );
      for (const n of [a.normal, a.localNormal])
        requireMotion(
          Math.abs(Math.hypot(...n) - 1) < 0.001,
          "INVALID_TARGET",
          "表面法线无效",
        );
      checkPoint(a.position, space);
    }
    if (p.ground !== null) {
      checkPoint(p.ground, space);
      requireMotion(
        !!space || p.ground[1] === 0,
        "INVALID_TARGET",
        "标点必须吸附到地面",
      );
      checkPoint(pointPosition(p as ActionPoint), space);
    }
  }
}
export function pointPosition(p: ActionPoint): Vec3 {
  requireMotion(p.ground, "POINT_UNPLACED", `请先将 ${p.name} 放置到场景`);
  const base = p.surface?.position ?? p.ground;
  const normal: Vec3 =
    p.offsetMode === "normal" && p.surface ? p.surface.normal : [0, 1, 0];
  return base.map((v, i) => v + normal[i] * p.height) as Vec3;
}
export function validateDocument(
  doc: unknown,
  points: ActionPoint[],
  ctx?: MotionContext,
): asserts doc is PromptPart[] {
  validatePoints(points, ctx?.space);
  requireMotion(
    Array.isArray(doc) && doc.length <= 1000,
    "INVALID_SCHEMA",
    "文本指导格式无效",
  );
  let length = 0;
  for (const part of doc) {
    requireMotion(object(part), "INVALID_SCHEMA", "文本内容无效");
    if (part.type === "text") {
      keys(part, ["type", "text"]);
      requireMotion(
        typeof part.text === "string",
        "INVALID_SCHEMA",
        "文本内容无效",
      );
      length += part.text.length;
    } else if (part.type === "animation") {
      keys(part, ["type", "clipId", "modelRevisionId"]);
      requireMotion(
        ctx &&
          part.modelRevisionId === revisionId(ctx) &&
          ctx.actor.animations.some(
            (c) =>
              c.id === part.clipId &&
              c.modelRevisionId === part.modelRevisionId,
          ),
        "CLIP_NOT_FOUND",
        "文本引用的动画不存在或不属于当前模型版本，请重新拖入动画",
      );
    } else {
      keys(part, ["type", "pointId"]);
      requireMotion(
        part.type === "point" && points.some((p) => p.id === part.pointId),
        "INVALID_TARGET",
        "文本引用了不存在的标点",
      );
    }
  }
  requireMotion(length <= 10000, "INVALID_SCHEMA", "文本指导不能超过 10000 字");
}
export function promptText(
  doc: PromptPart[],
  points: ActionPoint[],
  ctx?: MotionContext,
): string {
  return doc
    .map((p) =>
      p.type === "text"
        ? p.text
        : p.type === "animation"
          ? `[动画：${ctx?.actor.animations.find((c) => c.id === p.clipId)?.name ?? p.clipId}]`
          : `[${points.find((q) => q.id === p.pointId)?.name ?? "失效标点"}]`,
    )
    .join("");
}
export function validateAnimationReferences(
  doc: PromptPart[],
  plan: MotionPlan,
  ctx: MotionContext,
): void {
  const used = new Set(
    plan.steps.flatMap((s) =>
      s.type === "moveTo" || s.type === "playClip"
        ? [...(s.animation ? [s.animation] : []), ...(s.layers ?? [])].map(
            (use) => resolveClip(use, ctx).clip.id,
          )
        : [],
    ),
  );
  for (const part of doc)
    if (part.type === "animation")
      requireMotion(
        used.has(part.clipId),
        "CLIP_REFERENCE_IGNORED",
        `方案未使用指定动画：${ctx.actor.animations.find((c) => c.id === part.clipId)?.name ?? part.clipId}，请调整指导后重新生成`,
      );
}
function validateTarget(
  d: unknown,
  plan: MotionPlan,
  ctx: MotionContext,
): void {
  if (Array.isArray(d)) return checkPoint(d, ctx.space);
  requireMotion(object(d), "INVALID_TARGET", "目的地无效");
  if ("point" in d) {
    keys(d, ["point"]);
    const p = ctx.points?.find((p) => p.id === d.point);
    requireMotion(p, "INVALID_TARGET", "动作引用了不存在的标点");
    if (!ctx.allowUnplacedPoints || p.ground) pointPosition(p);
  } else if ("parameter" in d) {
    keys(d, ["parameter"]);
    requireMotion(
      typeof d.parameter === "string" &&
        Object.hasOwn(plan.parameters ?? {}, d.parameter),
      "INVALID_TARGET",
      "未声明目的地参数",
    );
  } else {
    keys(d, ["context"]);
    requireMotion(
      d.context === "actionStartPosition",
      "INVALID_TARGET",
      "未知上下文引用",
    );
  }
}
export interface ResolvedClip {
  clip: AnimationClip;
  start: number;
  end: number;
  rate: number;
  repeat: number | "untilArrival";
  use: ClipUse;
  entry: PoolEntry;
}
export class MotionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MotionError";
  }
}
export function requireMotion(
  ok: unknown,
  code: string,
  message: string,
): asserts ok {
  if (!ok) throw new MotionError(code, message);
}
function object(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function keys(v: object, allowed: string[]): void {
  requireMotion(
    Object.keys(v).every((k) => allowed.includes(k)),
    "INVALID_SCHEMA",
    "存在不支持的字段",
  );
}
function number(
  v: unknown,
  min: number,
  max: number,
  label: string,
): asserts v is number {
  requireMotion(
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= max,
    "INVALID_VALUE",
    `${label} 必须在 ${min}～${max} 之间`,
  );
}
export function checkPoint(v: unknown, space?: MotionSpace): asserts v is Vec3 {
  requireMotion(
    Array.isArray(v) && v.length === 3 && v.every(Number.isFinite),
    "INVALID_TARGET",
    "目的地必须是 [x,y,z]",
  );
  requireMotion(
    space
      ? v.every((n, i) => n >= space.min[i] && n <= space.max[i])
      : Math.abs(v[0]) <= 50 &&
          Math.abs(v[2]) <= 50 &&
          v[1] >= 0 &&
          v[1] <= 100,
    "TARGET_OUT_OF_BOUNDS",
    "目的地超出 100×100 地面或 0～100 高度范围",
  );
}
export function poolEntries(pool: ActionPool, actor: Actor): PoolEntry[] {
  return (
    pool.entries ??
    pool.clipIds.map((id, i) => {
      const c = actor.animations.find((c) => c.id === id)!;
      return {
        slot: `clip${i + 1}`,
        clipId: id,
        segments: [
          {
            name: "full",
            start: 0,
            end: c?.duration ?? 0,
            loop: Boolean((c?.animation as { loop?: boolean })?.loop),
          },
        ],
      };
    })
  );
}
export function validatePool(pool: ActionPool, actor: Actor): void {
  requireMotion(
    pool &&
      Array.isArray(pool.clipIds) &&
      pool.clipIds.length > 0 &&
      pool.clipIds.length <= 100 &&
      new Set(pool.clipIds).size === pool.clipIds.length,
    "INVALID_POOL",
    "动画池不能为空或重复",
  );
  requireMotion(
    pool.clipIds.every((id) =>
      actor.animations.some(
        (c) => c.id === id && c.modelRevisionId === pool.modelRevisionId,
      ),
    ),
    "MODEL_MISMATCH",
    "动画池必须绑定同一模型版本",
  );
  const entries = poolEntries(pool, actor),
    slots = new Set<string>();
  requireMotion(
    Array.isArray(entries) && entries.length > 0 && entries.length <= 100,
    "INVALID_POOL",
    "动画池用途配置无效",
  );
  for (const e of entries) {
    requireMotion(object(e), "INVALID_POOL", "用途配置无效");
    keys(e, [
      "slot",
      "clipId",
      "segments",
      "referenceSpeed",
      "minRate",
      "maxRate",
    ]);
    requireMotion(
      typeof e.slot === "string" &&
        /^[\w\u4e00-\u9fff-]{1,80}$/.test(e.slot) &&
        !slots.has(e.slot) &&
        pool.clipIds.includes(e.clipId),
      "INVALID_POOL",
      "用途名称重复、无效或动画不在池中",
    );
    slots.add(e.slot);
    const clip = actor.animations.find((c) => c.id === e.clipId)!;
    requireMotion(
      Array.isArray(e.segments) &&
        e.segments.length > 0 &&
        e.segments.length <= 100,
      "INVALID_SEGMENT",
      "需要有效片段",
    );
    const names = new Set();
    for (const s of e.segments) {
      requireMotion(object(s), "INVALID_SEGMENT", "片段无效");
      keys(s, ["name", "start", "end", "loop"]);
      requireMotion(
        typeof s.name === "string" &&
          s.name.length > 0 &&
          !names.has(s.name) &&
          typeof s.loop === "boolean",
        "INVALID_SEGMENT",
        "片段名称或循环设置无效",
      );
      number(s.start, 0, clip.duration, "片段起点");
      number(s.end, 0, clip.duration, "片段终点");
      requireMotion(s.end > s.start, "INVALID_SEGMENT", "片段终点必须大于起点");
      names.add(s.name);
    }
    if (e.referenceSpeed !== undefined)
      number(e.referenceSpeed, 0.01, 100, "参考移动速度");
    number(e.minRate ?? 0.25, 0.1, 4, "最小倍率");
    number(e.maxRate ?? 3, e.minRate ?? 0.25, 4, "最大倍率");
  }
}
export function resolveClip(use: ClipUse, ctx: MotionContext): ResolvedClip {
  requireMotion(object(use), "INVALID_SCHEMA", "缺少动画配置");
  keys(use, [
    "slot",
    "clipId",
    "segment",
    "start",
    "end",
    "rate",
    "repeat",
    "nodes",
    "weight",
    "blend",
  ]);
  const entry = animationEntries(ctx).find((e) =>
    use.clipId ? e.clipId === use.clipId : e.slot === use.slot,
  );
  requireMotion(
    entry,
    "CLIP_NOT_FOUND",
    `动画不存在：${use.clipId ?? use.slot}`,
  );
  const clip = ctx.actor.animations.find((c) => c.id === entry.clipId)!;
  const segment = entry.segments.find(
    (s) => s.name === (use.segment ?? "full"),
  );
  requireMotion(segment, "INVALID_SEGMENT", "用途中没有指定片段");
  const start = use.start ?? segment.start,
    end = use.end ?? segment.end,
    rate = use.rate ?? 1,
    repeat = use.repeat ?? 1;
  number(start, segment.start, segment.end, "片段起点");
  number(end, start, segment.end, "片段终点");
  requireMotion(end > start, "INVALID_SEGMENT", "片段不能为空");
  number(rate, entry.minRate ?? 0.25, entry.maxRate ?? 3, "播放倍率");
  if (repeat !== "untilArrival") {
    number(repeat, 1, 100, "播放次数");
    requireMotion(
      Number.isInteger(repeat),
      "INVALID_VALUE",
      "播放次数必须是整数",
    );
  }
  requireMotion(
    repeat === 1 || segment.loop,
    "INVALID_SEGMENT",
    "此动画片段未声明可循环，请使用单次片段",
  );
  if (use.weight !== undefined) number(use.weight, 0, 1, "混合权重");
  requireMotion(
    use.blend === undefined || ["override", "additive"].includes(use.blend),
    "INVALID_SCHEMA",
    "混合方式无效",
  );
  if (use.nodes !== undefined) {
    const model = ctx.actor.modelRevisions.find(
      (r) => r.id === revisionId(ctx),
    )!.modelJson as { nodes: { id: string }[] };
    requireMotion(
      Array.isArray(use.nodes) &&
        use.nodes.length > 0 &&
        use.nodes.every((id) => model.nodes.some((n) => n.id === id)),
      "UNKNOWN_NODE",
      "混合范围引用不存在的节点",
    );
  }
  return { clip, start, end, rate, repeat, use, entry };
}
export function validateAction(input: unknown, ctx: MotionContext): MotionPlan {
  requireMotion(object(input), "INVALID_SCHEMA", "动作文件必须是 JSON 对象");
  keys(input, [
    "schemaVersion",
    "name",
    "modelRevisionId",
    "poolId",
    "start",
    "parameters",
    "steps",
  ]);
  requireMotion(
    [1, 2].includes(input.schemaVersion) &&
      typeof input.name === "string" &&
      input.name.trim().length > 0 &&
      input.name.length <= 100,
    "INVALID_SCHEMA",
    "动作版本或名称无效",
  );
  requireMotion(
    input.modelRevisionId === revisionId(ctx) &&
      (!ctx.pool || ctx.pool.modelRevisionId === revisionId(ctx)) &&
      ctx.actor.modelRevisions.some((r) => r.id === input.modelRevisionId) &&
      (input.schemaVersion === 1
        ? !!ctx.pool && input.poolId === ctx.pool.id
        : input.poolId === undefined),
    "MODEL_MISMATCH",
    "动作与当前模型版本不匹配",
  );
  if (ctx.pool) validatePool(ctx.pool, ctx.actor);
  if (ctx.points) validatePoints(ctx.points, ctx.space);
  if (input.parameters !== undefined) {
    requireMotion(
      object(input.parameters) && Object.keys(input.parameters).length <= 20,
      "INVALID_SCHEMA",
      "参数定义无效",
    );
    for (const [name, p] of Object.entries(input.parameters)) {
      requireMotion(
        /^[a-zA-Z][\w]{0,50}$/.test(name) &&
          !["constructor", "prototype", "__proto__"].includes(name) &&
          object(p) &&
          p.type === "vec3",
        "INVALID_SCHEMA",
        "仅支持 vec3 目的地参数",
      );
      keys(p, ["type", "default"]);
      if (p.default !== undefined) checkPoint(p.default, ctx.space);
    }
  }
  const plan = input as unknown as MotionPlan,
    ids = new Set<string>();
  requireMotion(
    Array.isArray(plan.steps) &&
      plan.steps.length > 0 &&
      plan.steps.length <= 100,
    "INVALID_SCHEMA",
    "动作需要 1～100 个顺序步骤",
  );
  if (plan.start !== undefined) validateTarget(plan.start, plan, ctx);
  for (const s of plan.steps) {
    requireMotion(
      object(s) &&
        typeof s.id === "string" &&
        s.id.length > 0 &&
        s.id.length <= 100 &&
        !ids.has(s.id),
      "INVALID_SCHEMA",
      "步骤 ID 无效或重复",
    );
    ids.add(s.id);
    const common = ["id", "type", "transition", "markers"];
    const fields = {
      moveTo: [
        "destination",
        "speed",
        "path",
        "animation",
        "layers",
        "sync",
        "rootHeight",
        "finalHeading",
      ],
      playClip: ["animation", "layers", "seconds"],
      turnTo: ["heading", "target", "speed"],
      wait: ["seconds"],
    };
    requireMotion(
      Object.hasOwn(fields, s.type),
      "INVALID_SCHEMA",
      "不支持的动作指令",
    );
    keys(s, [...common, ...fields[s.type]]);
    if (s.transition !== undefined) number(s.transition, 0, 2, "过渡时长");
    if (s.markers !== undefined) {
      requireMotion(
        Array.isArray(s.markers) && s.markers.length <= 100,
        "INVALID_SCHEMA",
        "事件标记无效",
      );
      const markerNames = new Set();
      for (const m of s.markers) {
        requireMotion(
          object(m) &&
            typeof m.name === "string" &&
            m.name.length > 0 &&
            !markerNames.has(m.name),
          "INVALID_SCHEMA",
          "事件名无效或重复",
        );
        keys(m, ["name", "at"]);
        number(m.at, 0, 1, "事件进度");
        markerNames.add(m.name);
      }
    }
    if (s.type === "moveTo") {
      validateTarget(s.destination, plan, ctx);
      number(s.speed, 0.01, 100, "移动速度");
      if (s.path) {
        requireMotion(
          object(s.path) && ["ground", "air"].includes(s.path.mode),
          "INVALID_SCHEMA",
          "路径类型无效",
        );
        keys(s.path, ["mode", "via", "height"]);
        if (s.path.height !== undefined) number(s.path.height, 0, 50, "拱高");
        if (s.path.via !== undefined) {
          requireMotion(
            Array.isArray(s.path.via) && s.path.via.length <= 30,
            "INVALID_TARGET",
            "路径点无效",
          );
          s.path.via.forEach((d) => validateTarget(d, plan, ctx));
        }
        requireMotion(
          s.path.mode === "air" || !s.path.height,
          "CONSTRAINT_CONFLICT",
          "地面路径不能有飞行拱高",
        );
      }
      requireMotion(
        s.sync === undefined ||
          ["independent", "locomotion", "fitClip"].includes(s.sync),
        "INVALID_SCHEMA",
        "同步模式无效",
      );
      requireMotion(
        s.rootHeight === undefined ||
          ["animation", "path"].includes(s.rootHeight),
        "INVALID_SCHEMA",
        "高度控制方式无效",
      );
      requireMotion(
        s.path?.mode !== "air" || s.rootHeight !== "animation",
        "CONSTRAINT_CONFLICT",
        "空中路径必须拥有高度控制权",
      );
      if (s.finalHeading !== undefined)
        number(s.finalHeading, -360, 360, "最终朝向");
    }
    if (s.type === "moveTo" || s.type === "playClip") {
      if (plan.schemaVersion === 2) {
        for (const use of [
          ...(s.animation === null ? [] : [s.animation]),
          ...(s.layers ?? []),
        ])
          requireMotion(
            typeof use?.clipId === "string" && use.slot === undefined,
            "INVALID_SCHEMA",
            "动画必须通过 clipId 引用",
          );
      }
      const primary =
        s.animation === null ? null : resolveClip(s.animation, ctx);
      if (!primary) {
        requireMotion(
          plan.schemaVersion === 2,
          "INVALID_SCHEMA",
          "空动画卡槽仅适用于 v2 动作",
        );
        if (s.type === "playClip")
          number(s.seconds!, 0.000001, Number.MAX_SAFE_INTEGER, "空卡槽时长");
        else
          requireMotion(
            !s.sync || s.sync === "independent",
            "CONSTRAINT_CONFLICT",
            "空动画卡槽必须按移动速度执行",
          );
      } else if (s.type === "playClip") {
        requireMotion(
          s.seconds === undefined,
          "INVALID_SCHEMA",
          "有动画的卡槽由动画决定时长",
        );
      }
      if (primary && s.type === "playClip")
        requireMotion(
          primary.repeat !== "untilArrival",
          "CONSTRAINT_CONFLICT",
          "原地动画需要有限播放次数",
        );
      else if (primary && s.type === "moveTo") {
        if (s.sync === "fitClip")
          requireMotion(
            primary.repeat === 1,
            "CONSTRAINT_CONFLICT",
            "按片段同步只能播放一次",
          );
        if (s.sync === "locomotion")
          requireMotion(
            primary.entry.referenceSpeed,
            "UNAVAILABLE_CAPABILITY",
            "尚未标定参考移动速度",
          );
      }
      if (s.layers !== undefined) {
        requireMotion(
          Array.isArray(s.layers) && s.layers.length <= 4,
          "INVALID_SCHEMA",
          "最多叠加四层动画",
        );
        for (const layer of s.layers) {
          const l = resolveClip(layer, ctx);
          requireMotion(
            l.repeat !== "untilArrival",
            "CONSTRAINT_CONFLICT",
            "叠加层使用有限播放次数",
          );
          requireMotion(
            layer.nodes?.length,
            "UNKNOWN_NODE",
            "叠加层必须明确指定节点（包含子树）",
          );
        }
      }
    }
    if (s.type === "turnTo") {
      requireMotion(
        (s.heading !== undefined) !== (s.target !== undefined),
        "INVALID_TARGET",
        "转向需要角度或朝向目标，二者选一",
      );
      if (s.target !== undefined) validateTarget(s.target, plan, ctx);
      else number(s.heading, -360, 360, "朝向");
      number(s.speed, 1, 720, "转向速度");
    }
    if (s.type === "wait") number(s.seconds, 0.01, 600, "等待时间");
  }
  return structuredClone(plan);
}

export function capabilities(ctx: MotionContext) {
  if (ctx.pool) validatePool(ctx.pool, ctx.actor);
  if (ctx.points) validatePoints(ctx.points, ctx.space);
  const model = ctx.actor.modelRevisions.find((r) => r.id === revisionId(ctx))!
    .modelJson as { nodes: { id: string; parent?: string }[] };
  return {
    schemaVersion: ctx.pool ? 1 : 2,
    modelRevisionId: revisionId(ctx),
    ...(ctx.pool ? { poolId: ctx.pool.id } : {}),
    bounds: { x: [-50, 50], y: [0, 100], z: [-50, 50] },
    points: (ctx.points ?? []).map((p) => ({
      ...structuredClone(p),
      position: p.ground ? pointPosition(p) : null,
    })),
    nodes: model.nodes.map((n) => ({ id: n.id, parent: n.parent })),
    animations: animationEntries(ctx).map((e) => ({
      ...(ctx.pool
        ? e
        : {
            clipId: e.clipId,
            segments: e.segments,
            referenceSpeed: e.referenceSpeed,
            minRate: e.minRate,
            maxRate: e.maxRate,
          }),
      name: ctx.actor.animations.find((c) => c.id === e.clipId)!.name,
    })),
    commands: ["moveTo", "playClip", "turnTo", "wait"],
  };
}
