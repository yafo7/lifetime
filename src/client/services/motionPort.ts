import { motionProtocol } from "./motionPlanner";
import {
  capabilities,
  revisionId,
  MotionError,
  type MotionContext,
  type MotionPlan,
  type Vec3,
} from "../../shared/motion";
import type { Viewport } from "../rendering/viewport";
import type { MotionOrigin } from "../motion/runtime";

/** Public in-page port. All callers must identify the currently loaded actor instance. */
export class MotionPort {
  private ctx: MotionContext | null = null;
  private instanceId = "";
  constructor(
    private view: Viewport,
    private onExecute: () => void,
  ) {}
  bind(ctx: MotionContext | null, instanceId = ""): void {
    this.ctx = ctx;
    this.instanceId = instanceId;
  }
  private context(id?: string): MotionContext {
    if (!this.ctx || (id !== undefined && id !== this.instanceId))
      throw new MotionError(
        "MODEL_NOT_READY",
        "演员实例未加载或与当前预览不匹配",
      );
    return this.view.resolveMotionContext(this.ctx);
  }
  getProtocol(): string {
    return motionProtocol;
  }
  moveTo(
    step: Omit<
      Extract<import("../../shared/motion").MotionStep, { type: "moveTo" }>,
      "type" | "id"
    >,
    actorInstanceId: string,
    options: { replace?: boolean } = {},
  ) {
    const ctx = this.context(actorInstanceId);
    const plan: MotionPlan = {
      schemaVersion: ctx.pool ? 1 : 2,
      name: "移动到目标点",
      poolId: ctx.pool?.id,
      modelRevisionId: revisionId(ctx),
      steps: [{ ...step, id: "move", type: "moveTo" }],
    };
    return this.executeAction(plan, actorInstanceId, {}, options);
  }
  getCapabilities() {
    return {
      actorInstanceId: this.instanceId,
      ...capabilities(this.context()),
    };
  }
  getOrigin(): MotionOrigin {
    return this.view.getMotionOrigin();
  }
  inspectAction(plan: unknown, origin = this.getOrigin()) {
    return this.view.motion.inspectAction(
      plan,
      this.context(),
      {},
      origin.position,
      origin.heading,
    );
  }
  invalidateAction(): void {
    this.view.invalidateAction();
  }
  validateAction(
    plan: unknown,
    parameters: Record<string, Vec3> = {},
    origin = this.getOrigin(),
  ) {
    return this.view.motion.validateAction(
      plan,
      this.context(),
      parameters,
      origin.position,
      origin.heading,
    );
  }
  executeAction(
    plan: MotionPlan,
    actorInstanceId: string,
    parameters: Record<string, Vec3> = {},
    options: { replace?: boolean; origin?: MotionOrigin } = {},
  ) {
    const id = this.view.executeAction(
      plan,
      this.context(actorInstanceId),
      actorInstanceId,
      parameters,
      options.replace,
      options.origin,
    );
    this.onExecute();
    return id;
  }
  getExecutionState(executionId?: string) {
    return this.view.motion.getExecutionState(executionId);
  }
  pauseExecution(executionId: string) {
    this.view.motion.pauseExecution(executionId);
  }
  resumeExecution(executionId: string) {
    this.view.motion.resumeExecution(executionId);
  }
  cancelExecution(executionId: string) {
    this.view.motion.cancelExecution(executionId);
  }
  subscribe(listener: Parameters<Viewport["motion"]["subscribe"]>[0]) {
    return this.view.motion.subscribe(listener);
  }
}
declare global {
  interface Window {
    lifetimeMotion: MotionPort;
  }
}
