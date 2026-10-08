import {
  checkPoint,
  pointPosition,
  type Target,
  requireMotion,
  resolveClip,
  validateAction,
  type MotionContext,
  type MotionPlan,
  type MotionStep,
  type ResolvedClip,
  type Vec3,
} from "../../shared/motion";

export interface MotionFrame {
  position: Vec3;
  heading: number;
  animation?: { clip: ResolvedClip; time: number };
  layers: { clip: ResolvedClip; time: number; weight: number }[];
  transition: number;
  stepId: string;
  rootHeight: "animation" | "path";
  preserveRoot?: boolean;
}
export interface ExecutionEvent {
  executionId: string;
  type: string;
  stepId?: string;
  marker?: string;
  elapsed: number;
}
interface CompiledStep {
  source: MotionStep;
  from: Vec3;
  to: Vec3;
  heading: number;
  endHeading: number;
  duration: number;
  points: Vec3[];
  distances: number[];
  length: number;
  animation?: ResolvedClip;
  layers: ResolvedClip[];
}
export interface ExecutionState {
  executionId: string;
  actorInstanceId: string;
  status: "running" | "paused" | "completed" | "cancelled" | "failed";
  stepId: string;
  elapsed: number;
  duration: number;
  position: Vec3;
  heading: number;
}
export interface MotionOrigin {
  position: Vec3;
  heading: number;
}
export interface ActionTiming {
  stepId: string;
  type: MotionStep["type"];
  start: number;
  end: number;
  duration: number;
  clipId?: string;
  rate?: number;
}
const distance = (a: Vec3, b: Vec3) => Math.hypot(...a.map((v, i) => v - b[i]));
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 =>
  a.map((v, i) => v + (b[i] - v) * t) as Vec3;
const angle = (a: number, b: number) =>
  Math.atan2(Math.sin(b - a), Math.cos(b - a));
export interface MotionEnvironment {
  route?: (from: Vec3, to: Vec3, via: Vec3[]) => Vec3[];
  stationary?: (position: Vec3, source: MotionStep) => void;
  preserveRoot?: boolean;
}
function compile(
  plan: MotionPlan,
  ctx: MotionContext,
  parameters: Record<string, Vec3>,
  start: Vec3,
  heading: number,
  environment: MotionEnvironment = {},
): CompiledStep[] {
  checkPoint(start, ctx.space);
  requireMotion(
    parameters &&
      typeof parameters === "object" &&
      !Array.isArray(parameters) &&
      Object.keys(parameters).every((k) =>
        Object.hasOwn(plan.parameters ?? {}, k),
      ),
    "INVALID_TARGET",
    "存在未声明的执行参数",
  );
  const params: Record<string, Vec3> = Object.create(null);
  for (const [name, p] of Object.entries(plan.parameters ?? {})) {
    const v = Object.hasOwn(parameters, name) ? parameters[name] : p.default;
    requireMotion(v, "INVALID_TARGET", `缺少参数：${name}`);
    checkPoint(v, ctx.space);
    params[name] = [...v];
  }
  const targetPosition = (target: Target): Vec3 => {
    const v = Array.isArray(target)
      ? target
      : "point" in target
        ? pointPosition(ctx.points!.find((p) => p.id === target.point)!)
        : "parameter" in target
          ? params[target.parameter]
          : start;
    return [...v];
  };
  if (plan.start) start = targetPosition(plan.start);
  let position: Vec3 = [...start];
  return plan.steps.map((source) => {
    const from: Vec3 = [...position];
    let to = from,
      endHeading = heading,
      duration = 0,
      length = 0;
    let points = [from],
      distances = [0];
    let animation: ResolvedClip | undefined;
    const layers: ResolvedClip[] = [];
    if (source.type === "moveTo" || source.type === "playClip") {
      animation = source.animation
        ? resolveClip(source.animation, ctx)
        : undefined;
      layers.push(...(source.layers ?? []).map((l) => resolveClip(l, ctx)));
    }
    if (source.type === "moveTo") {
      to = targetPosition(source.destination);
      points = [from, ...(source.path?.via ?? []).map(targetPosition), to];
      if ((source.path?.mode ?? "ground") === "ground" && environment.route) {
        points = environment.route(from, to, points.slice(1, -1));
        to = [...points.at(-1)!];
      } else if ((source.path?.mode ?? "ground") === "ground")
        requireMotion(
          points.every((p) => Math.abs(p[1]) < 1e-6),
          "CONSTRAINT_CONFLICT",
          "地面路径所有点的高度必须为 0",
        );
      requireMotion(
        Math.max(...points.map((p) => p[1])) + (source.path?.height ?? 0) <=
          (ctx.space?.max[1] ?? 100),
        "TARGET_OUT_OF_BOUNDS",
        "飞行路径超出高度边界",
      );
      distances = [0];
      for (let i = 1; i < points.length; i++) {
        length += distance(points[i - 1], points[i]);
        distances.push(length);
      }
      if (source.path?.height) {
        const original = points,
          cumulative = distances,
          baseLength = length;
        const samples: Vec3[] = [];
        for (let j = 0; j <= 64; j++) {
          const u = j / 64,
            along = baseLength * u;
          let i = 1;
          while (i < original.length - 1 && cumulative[i] < along) i++;
          const span = cumulative[i] - cumulative[i - 1];
          const p = lerp(
            original[i - 1],
            original[i],
            span ? (along - cumulative[i - 1]) / span : u,
          );
          p[1] += 4 * source.path.height * u * (1 - u);
          samples.push(p);
        }
        points = samples;
        distances = [0];
        length = 0;
        for (let i = 1; i < points.length; i++) {
          length += distance(points[i - 1], points[i]);
          distances.push(length);
        }
      }
      duration = length / source.speed;
      const a = animation;
      if (a && source.sync === "fitClip") {
        // Destination is exact; the requested move speed is solved from clip time in this mode.
        duration = (a.end - a.start) / a.rate;
      } else if (a && source.sync === "locomotion") {
        a.rate = source.speed / a.entry.referenceSpeed!;
        requireMotion(
          a.rate >= (a.entry.minRate ?? 0.25) &&
            a.rate <= (a.entry.maxRate ?? 3),
          "CONSTRAINT_CONFLICT",
          "移动速度对应的步频超出允许倍率",
        );
      }
      if (a && a.repeat !== "untilArrival" && source.sync !== "fitClip")
        requireMotion(
          duration <= ((a.end - a.start) / a.rate) * a.repeat + 1e-6,
          "CONSTRAINT_CONFLICT",
          "动画播放时间不足以到达目的地；使用可循环片段或 fitClip",
        );
      const last = points
        .slice(0, -1)
        .reverse()
        .find((p) => Math.hypot(to[0] - p[0], to[2] - p[2]) > 1e-6);
      if (last) endHeading = Math.atan2(to[0] - last[0], to[2] - last[2]);
      if (source.finalHeading !== undefined)
        endHeading = (source.finalHeading * Math.PI) / 180;
    } else if (source.type === "playClip")
      duration = animation
        ? ((animation.end - animation.start) / animation.rate) *
          (animation.repeat as number)
        : source.seconds!;
    else if (source.type === "wait") duration = source.seconds;
    else {
      if (source.target) {
        const target = targetPosition(source.target);
        requireMotion(
          Math.hypot(target[0] - from[0], target[2] - from[2]) > 1e-6,
          "INVALID_TARGET",
          "朝向目标不能与角色站位重合",
        );
        endHeading = Math.atan2(target[0] - from[0], target[2] - from[2]);
      } else endHeading = (source.heading! * Math.PI) / 180;
      duration =
        (Math.abs(angle(heading, endHeading)) * 180) / Math.PI / source.speed;
    }
    if (source.type === "playClip") environment.stationary?.(from, source);
    const step = {
      source,
      from,
      to,
      heading,
      endHeading,
      duration: Math.max(duration, 1e-6),
      points,
      distances,
      length,
      animation,
      layers,
    };
    position = [...to];
    heading = endHeading;
    return step;
  });
}
function clipTime(c: ResolvedClip, elapsed: number, final: boolean): number {
  const length = c.end - c.start,
    time = elapsed * c.rate;
  if (c.repeat !== "untilArrival" && time >= length * c.repeat - 1e-8)
    return c.end;
  if (final && time > 0 && Math.abs(time % length) < 1e-8) return c.end;
  return c.start + (time % length);
}

/** Deterministic runtime. No DOM, network, LLM, or animation generation. */
export class MotionRuntime {
  constructor(private environment: MotionEnvironment = {}) {}
  private steps: CompiledStep[] = [];
  private index = 0;
  private local = 0;
  private elapsed = 0;
  private state: ExecutionState | null = null;
  private listeners = new Set<(event: ExecutionEvent) => void>();
  private markers = new Set<string>();
  frame: MotionFrame | null = null;
  subscribe(listener: (event: ExecutionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(type: string, marker?: string): void {
    if (!this.state) return;
    const event = {
      executionId: this.state.executionId,
      type,
      stepId: this.steps[this.index]?.source.id,
      elapsed: this.elapsed,
      marker,
    };
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch (e) {
        console.warn("运动事件订阅者异常", e);
      }
    }
  }
  validateAction(
    plan: unknown,
    ctx: MotionContext,
    parameters: Record<string, Vec3> = {},
    start: Vec3 = [0, 0, 0],
    heading = 0,
  ): MotionPlan {
    const valid = validateAction(plan, ctx);
    compile(valid, ctx, parameters, start, heading, this.environment);
    return valid;
  }
  /** Uses the execution compiler, so editing and playback report the same timing. */
  inspectAction(
    plan: unknown,
    ctx: MotionContext,
    parameters: Record<string, Vec3> = {},
    start: Vec3 = [0, 0, 0],
    heading = 0,
  ): ActionTiming[] {
    const steps = compile(
      validateAction(plan, ctx),
      ctx,
      parameters,
      start,
      heading,
      this.environment,
    );
    let time = 0;
    return steps.map((s) => {
      const begin = time;
      time += s.duration;
      return {
        stepId: s.source.id,
        type: s.source.type,
        start: begin,
        end: time,
        duration: s.duration,
        clipId: s.animation?.clip.id,
        rate: s.animation?.rate,
      };
    });
  }
  executeAction(
    plan: unknown,
    ctx: MotionContext,
    actorInstanceId: string,
    parameters: Record<string, Vec3> = {},
    start: Vec3 = [0, 0, 0],
    heading = 0,
    replace = false,
  ): string {
    const valid = validateAction(plan, ctx),
      steps = compile(valid, ctx, parameters, start, heading, this.environment);
    requireMotion(
      Number.isFinite(heading) &&
        typeof actorInstanceId === "string" &&
        actorInstanceId.length > 0,
      "INVALID_VALUE",
      "演员实例或朝向无效",
    );
    if (this.state && ["running", "paused"].includes(this.state.status)) {
      requireMotion(replace, "EXECUTION_CONFLICT", "当前演员已有执行中的动作");
      this.cancelExecution(this.state.executionId);
    }
    this.steps = steps;
    this.index = 0;
    this.local = 0;
    this.elapsed = 0;
    this.markers.clear();
    const id = crypto.randomUUID();
    this.state = {
      executionId: id,
      actorInstanceId,
      status: "running",
      stepId: steps[0].source.id,
      elapsed: 0,
      duration: steps.reduce((sum, s) => sum + s.duration, 0),
      position: [...start],
      heading,
    };
    this.sample();
    this.emit("started");
    this.emit("stepStarted");
    this.emitMarkers();
    return id;
  }
  getTrajectory(): Vec3[][] {
    return this.steps
      .filter((s) => s.source.type === "moveTo")
      .map((s) => s.points.map((p) => [...p] as Vec3));
  }
  getExecutionState(id?: string): ExecutionState | null {
    if (id) this.assertId(id);
    return this.state ? structuredClone(this.state) : null;
  }
  private assertId(id: string): void {
    requireMotion(
      this.state?.executionId === id,
      "EXECUTION_NOT_FOUND",
      "执行实例不存在或已被替换",
    );
  }
  pauseExecution(id: string): void {
    this.assertId(id);
    if (this.state!.status === "running") {
      this.state!.status = "paused";
      this.emit("paused");
    }
  }
  resumeExecution(id: string): void {
    this.assertId(id);
    if (this.state!.status === "paused") {
      this.state!.status = "running";
      this.emit("resumed");
    }
  }
  cancelExecution(id: string): void {
    this.assertId(id);
    if (["running", "paused"].includes(this.state!.status)) {
      this.state!.status = "cancelled";
      this.emit("cancelled");
    }
  }
  reset(): void {
    if (this.state) this.cancelExecution(this.state.executionId);
    this.state = null;
    this.steps = [];
    this.frame = null;
  }
  seekExecution(id: string, seconds: number): void {
    this.assertId(id);
    requireMotion(Number.isFinite(seconds), "INVALID_VALUE", "进度时间无效");
    const duration = this.state!.duration,
      target = Math.max(0, Math.min(duration, seconds));
    const running = this.state!.status === "running";
    this.index = 0;
    this.local = target;
    this.elapsed = target;
    while (
      this.index < this.steps.length - 1 &&
      this.local >= this.steps[this.index].duration
    ) {
      this.local -= this.steps[this.index].duration;
      this.index++;
    }
    this.state!.status =
      target >= duration ? "completed" : running ? "running" : "paused";
    this.markers.clear();
    for (const marker of this.steps[this.index].source.markers ?? [])
      if (marker.at <= this.local / this.steps[this.index].duration)
        this.markers.add(marker.name);
    this.sample();
    this.emit("seeked");
  }
  advance(dt: number): void {
    requireMotion(
      Number.isFinite(dt) && dt >= 0,
      "INVALID_VALUE",
      "时间增量无效",
    );
    if (this.state?.status !== "running") return;
    while (dt > 0 && this.state.status === "running") {
      const step = this.steps[this.index],
        amount = Math.min(dt, step.duration - this.local);
      this.local += amount;
      this.elapsed += amount;
      dt -= amount;
      this.sample();
      this.emitMarkers();
      if (this.local >= step.duration - 1e-9) {
        if (step.source.type === "moveTo") this.emit("destinationReached");
        this.emit("stepCompleted");
        if (this.index + 1 === this.steps.length) {
          this.state.status = "completed";
          this.emit("completed");
        } else {
          this.index++;
          this.local = 0;
          this.markers.clear();
          this.sample();
          this.emit("stepStarted");
          this.emitMarkers();
        }
      }
    }
  }
  private emitMarkers(): void {
    const s = this.steps[this.index];
    for (const m of s.source.markers ?? [])
      if (this.local / s.duration + 1e-9 >= m.at && !this.markers.has(m.name)) {
        this.markers.add(m.name);
        this.emit("markerReached", m.name);
      }
  }
  private sample(): void {
    const s = this.steps[this.index],
      t = Math.min(1, this.local / s.duration),
      source = s.source;
    let position: Vec3 = [...s.from],
      heading = s.heading;
    if (source.type === "moveTo") {
      const along = s.length * t;
      let i = 1;
      while (i < s.points.length - 1 && s.distances[i] < along) i++;
      const a = s.points[i - 1],
        b = s.points[i],
        span = s.distances[i] - s.distances[i - 1];
      position = lerp(a, b, span ? (along - s.distances[i - 1]) / span : 1);

      if (Math.hypot(b[0] - a[0], b[2] - a[2]) > 1e-6)
        heading = Math.atan2(b[0] - a[0], b[2] - a[2]);
      // Smooth the initial turn, then converge to an optional final facing.
      heading =
        s.heading + angle(s.heading, heading) * Math.min(1, this.local / 0.2);
      if (source.finalHeading !== undefined)
        heading += angle(heading, s.endHeading) * Math.max(0, (t - 0.8) / 0.2);
      if (t === 1) {
        position = [...s.to];
        heading = s.endHeading;
      }
    } else if (source.type === "turnTo")
      heading += angle(heading, s.endHeading) * t;
    const layers = s.layers.map((c) => {
      const duration = ((c.end - c.start) / c.rate) * (c.repeat as number);
      const fade = Math.min(0.15, duration / 4);
      const envelope = Math.min(
        1,
        this.local / fade,
        Math.max(0, (duration - this.local) / fade),
      );
      return {
        clip: c,
        time: clipTime(c, Math.min(this.local, duration), true),
        weight: (c.use.weight ?? 1) * envelope,
      };
    });
    this.frame = {
      position,
      heading,
      stepId: source.id,
      layers,
      transition: Math.min(
        1,
        this.local / Math.max(0.000001, source.transition ?? 0.15),
      ),
      preserveRoot: this.environment.preserveRoot && source.type === "playClip",
      rootHeight:
        source.type === "moveTo"
          ? source.path?.mode === "air"
            ? "path"
            : (source.rootHeight ?? "animation")
          : "animation",
      animation: s.animation
        ? {
            clip: s.animation,
            time: clipTime(s.animation, this.local, t === 1),
          }
        : undefined,
    };
    Object.assign(this.state!, {
      stepId: source.id,
      elapsed: this.elapsed,
      position: [...position],
      heading,
    });
  }
}
