import type { Actor, ActorInstance } from "../../shared/contracts";
import type { MapResource } from "../../shared/maps";
import {
  sceneContext,
  sceneActionPlan,
  validateSceneMotion,
  type NavigationProfile,
  type SceneMotion,
} from "../../shared/sceneMotion";
import {
  MotionError,
  checkPoint,
  pointPosition,
  type MotionPlan,
  type Vec3,
  type MotionContext,
} from "../../shared/motion";
import { mapSpace } from "../../shared/sceneMotion";
import {
  MotionRuntime,
  type ActionTiming,
  type ExecutionEvent,
  type ExecutionState,
  type MotionOrigin,
} from "../motion/runtime";
import { buildSceneGeometry, type SceneGeometry } from "../navigation/geometry";
import { Navigation } from "../navigation/navigation";
import { checkStationaryClearance } from "../navigation/actionClearance";
import type { Viewport } from "../rendering/viewport";
import {
  CharacterMachineRuntime,
  type CharacterMachineState,
} from "../motion/characterMachine";
import type { CharacterMachine } from "../../shared/characterMachine";
import { actionInputs } from "../../shared/actionBinding";

export interface PreparedSceneAction {
  runtime: MotionRuntime;
  plan: MotionPlan;
  context: MotionContext;
  origin: MotionOrigin;
  timings: ActionTiming[];
  signature: string;
  instanceId: string;
}
/** Stable programmatic boundary. Every scene action is validated before any live pose changes. */
export class SceneMotionPort {
  private map: MapResource | null = null;
  private actors = new Map<string, Actor>();
  private instances: ActorInstance[] = [];
  private geometry: Promise<SceneGeometry> | null = null;
  private snapshot: SceneGeometry | null = null;
  private navigations = new Map<
    string,
    { nav: Navigation; ready: Promise<void> }
  >();
  private executions = new Map<string, PreparedSceneAction>();
  private machines = new Map<string, CharacterMachineRuntime>();
  private generation = 0;
  private listeners = new Set<(e: ExecutionEvent) => void>();
  private machineListeners = new Set<
    (instanceId: string, state: CharacterMachineState) => void
  >();
  onChange = () => {};
  onConfigurationChange = (_instanceId: string) => {};
  constructor(private view: Viewport) {
    view.onSceneFrame = (dt) => this.advance(dt);
  }
  bind(
    map: MapResource,
    actors: Map<string, Actor>,
    instances: ActorInstance[],
  ) {
    this.clear();
    this.map = map;
    this.actors = actors;
    this.instances = instances;
  }
  unbind() {
    this.clear();
    this.map = null;
    this.instances = [];
    this.actors = new Map();
  }
  private instance(id: string) {
    const i = this.instances.find((i) => i.id === id);
    if (!i || !this.map) throw new Error("场景演员不存在");
    return i;
  }
  private signature(i: ActorInstance) {
    return JSON.stringify([
      this.generation,
      i.position,
      i.rotation,
      i.scale,
      i.modelRevisionId,
      i.sceneMotion?.actions.map((a) =>
        "actorActionId" in a
          ? this.actors
              .get(i.actorId)
              ?.motionActions?.find((source) => source.id === a.actorActionId)
              ?.updatedAt
          : null,
      ),
      i.sceneMotion,
    ]);
  }
  async getGeometry() {
    if (!this.map) throw new Error("请先打开地图");
    const generation = this.generation;
    if (!this.geometry)
      this.geometry = buildSceneGeometry(
        this.map.map,
        this.view.getFoundations(),
      )
        .then((g) => {
          if (generation !== this.generation) {
            g.dispose();
            throw new Error("地图已切换");
          }
          this.snapshot = g;
          this.view.setSceneGeometry(g);
          return g;
        })
        .catch((e) => {
          if (generation === this.generation) this.geometry = null;
          throw e;
        });
    return this.geometry;
  }
  private async navigation(profile: NavigationProfile) {
    const key = JSON.stringify(profile);
    let item = this.navigations.get(key);
    if (!item) {
      const nav = new Navigation(profile);
      const generation = this.generation;
      const ready = this.getGeometry().then((g) => {
        if (generation !== this.generation) throw new Error("地图已切换");
        return nav.build(g);
      });
      item = { nav, ready };
      this.navigations.set(key, item);
      ready.catch(() => {
        if (this.navigations.get(key)?.nav === nav)
          this.navigations.delete(key);
        nav.dispose();
      });
    }
    await item.ready;
    return item.nav;
  }
  /** Shared local navigation boundary for semantic placement; never sent to the planner. */
  getNavigation(profile: NavigationProfile) {
    return this.navigation(profile);
  }
  async prepareAction(
    instanceId: string,
    actionId?: string,
    continuation?: MotionOrigin,
  ): Promise<PreparedSceneAction> {
    const original = this.instance(instanceId),
      signature = this.signature(original),
      i = structuredClone(original),
      actor = this.actors.get(i.actorId)!;
    const config = i.sceneMotion;
    if (!config) throw new Error("请先制作场景动作");
    validateSceneMotion(config, actor, i, this.map!.map);
    const action = config.actions.find(
      (a) => a.id === (actionId ?? config.selectedActionId),
    );
    if (!action) throw new Error("请选择场景动作");
    const nav = await this.navigation(config.navigation);
    if (signature !== this.signature(this.instance(instanceId)))
      throw new Error("配置已更改，请重新计算路线");
    const ctx = this.view.resolveMotionContext(
      sceneContext(actor, i, this.map!.map),
    );
    const startPoint = config.startPointId
      ? ctx.points!.find((p) => p.id === config.startPointId)!
      : null;
    const origin = {
      position: nav.project(
        continuation?.position ??
          (startPoint ? pointPosition(startPoint) : i.position),
      ),
      heading: continuation?.heading ?? (i.rotation * Math.PI) / 180,
    };
    const plan = sceneActionPlan(action, ctx);
    delete plan.start;
    const runtime = new MotionRuntime({
      route: (from, to, via) => nav.route(from, to, via),
      preserveRoot: true,
      stationary: (position) => {
        nav.project(position);
      },
    });
    const timings = runtime.inspectAction(
      plan,
      ctx,
      {},
      origin.position,
      origin.heading,
    );
    // compile/validate without starting the live instance; use the same runtime and timings for execution.
    runtime.executeAction(
      plan,
      ctx,
      instanceId,
      {},
      origin.position,
      origin.heading,
    );
    await checkStationaryClearance(actor, i, this.map!.map, runtime, timings);
    if (signature !== this.signature(this.instance(instanceId)))
      throw new Error("配置已更改，请重新计算路线");
    runtime.reset();
    runtime.executeAction(
      plan,
      ctx,
      instanceId,
      {},
      origin.position,
      origin.heading,
    );
    const state = runtime.getExecutionState()!;
    runtime.pauseExecution(state.executionId);
    return {
      runtime,
      plan,
      context: ctx,
      origin,
      timings,
      signature,
      instanceId,
    };
  }
  async previewRoute(instanceId: string) {
    const p = await this.prepareAction(instanceId);
    this.view.showSceneGuide(instanceId, p.runtime.getTrajectory());
    return p.timings;
  }
  async executeAction(instanceId: string, actionId?: string) {
    const p = await this.prepareAction(instanceId, actionId);
    this.startPrepared(p);
    return p.runtime.getExecutionState()!.executionId;
  }
  startPrepared(p: PreparedSceneAction, fromMachine = false) {
    const i = this.instance(p.instanceId);
    if (p.signature !== this.signature(i))
      throw new MotionError("STALE_PLAN", "配置已修改，请重新计算动作");
    if (fromMachine) {
      this.executions.get(i.id)?.runtime.reset();
      this.executions.delete(i.id);
    } else this.invalidate(i.id);
    p.runtime.reset();
    this.executions.set(i.id, p);
    p.runtime.subscribe((e) => {
      for (const listener of this.listeners) {
        try {
          listener(e);
        } catch {
          /* caller isolated */
        }
      }
      this.onChange();
    });
    p.runtime.executeAction(
      p.plan,
      p.context,
      i.id,
      {},
      p.origin.position,
      p.origin.heading,
    );
    this.view.showSceneGuide(i.id, p.runtime.getTrajectory());
    this.view.applySceneFrame(i.id, p.runtime.frame!);
    this.onChange();
  }
  getExecutionState(instanceId: string): ExecutionState | null {
    return this.executions.get(instanceId)?.runtime.getExecutionState() ?? null;
  }
  seekExecution(instanceId: string, seconds: number) {
    // Seeking edits the current state's action only; it never skips state transitions.
    const p = this.executions.get(instanceId),
      state = p?.runtime.getExecutionState();
    if (!p || !state) throw new Error("请先播放动作");
    this.machines.get(instanceId)?.seekAction();
    p.runtime.seekExecution(state.executionId, seconds);
    this.view.seekSceneFrame(instanceId, p.runtime.frame!);
    this.onChange();
  }
  pauseExecution(instanceId: string) {
    if (this.machines.has(instanceId)) {
      this.machines.get(instanceId)!.pause();
      return;
    }
    this.pauseAction(instanceId);
  }
  private pauseAction(instanceId: string) {
    const p = this.executions.get(instanceId),
      s = p?.runtime.getExecutionState();
    if (s) p!.runtime.pauseExecution(s.executionId);
    this.onChange();
  }
  resumeExecution(instanceId: string) {
    if (this.machines.has(instanceId)) {
      this.machines.get(instanceId)!.resume();
      return;
    }
    this.resumeAction(instanceId);
  }
  private resumeAction(instanceId: string) {
    const p = this.executions.get(instanceId),
      s = p?.runtime.getExecutionState();
    if (p && p.signature !== this.signature(this.instance(instanceId))) {
      this.invalidate(instanceId);
      throw new Error("演员动作或地图配置已更新，请重新播放");
    }
    if (s) p!.runtime.resumeExecution(s.executionId);
    this.onChange();
  }
  cancelExecution(instanceId: string) {
    this.invalidate(instanceId);
    this.onChange();
  }
  invalidate(instanceId: string) {
    this.machines.get(instanceId)?.stop();
    this.machines.delete(instanceId);
    this.invalidateAction(instanceId);
  }
  private invalidateAction(instanceId: string) {
    const p = this.executions.get(instanceId);
    p?.runtime.reset();
    this.executions.delete(instanceId);
    this.view.clearSceneGuide(instanceId);
    const i = this.instances.find((i) => i.id === instanceId);
    if (i) {
      const actor = this.actors.get(i.actorId);
      this.view.resetSceneInstance(
        i,
        actor?.animations.find((c) => c.id === i.clipId) ?? null,
      );
    }
  }
  updateConfiguration(
    instanceId: string,
    update: (draft: ActorInstance) => void,
  ) {
    const i = this.instance(instanceId),
      draft = structuredClone(i);
    update(draft);
    if (
      draft.id !== i.id ||
      draft.actorId !== i.actorId ||
      draft.modelRevisionId !== i.modelRevisionId ||
      !Number.isFinite(draft.scale) ||
      draft.scale <= 0 ||
      !Number.isFinite(draft.rotation)
    )
      throw new Error("不能通过动作接口更改演员绑定或使用无效变换");
    checkPoint(draft.position, mapSpace(this.map!.map));
    const actor = this.actors.get(i.actorId)!;
    if (draft.sceneMotion)
      validateSceneMotion(draft.sceneMotion, actor, draft, this.map!.map);
    Object.assign(i, draft);
    this.invalidate(instanceId);
    this.onChange();
    this.onConfigurationChange(instanceId);
  }
  getConfiguration(instanceId: string) {
    return structuredClone(this.instance(instanceId));
  }
  updateActor(actor: Actor) {
    if (!this.actors.has(actor.id)) throw new Error("场景演员不存在");
    this.actors.set(actor.id, actor);
    for (const i of this.instances.filter((i) => i.actorId === actor.id))
      this.invalidate(i.id);
    this.onChange();
  }
  setConfiguration(instanceId: string, value: SceneMotion) {
    this.updateConfiguration(instanceId, (i) => {
      i.sceneMotion = structuredClone(value);
    });
  }
  getActorActions(instanceId: string) {
    const i = this.instance(instanceId);
    return (this.actors.get(i.actorId)?.motionActions ?? [])
      .filter((a) => a.modelRevisionId === i.modelRevisionId)
      .map((a) => ({
        id: a.id,
        name: a.name,
        updatedAt: a.updatedAt,
        inputs: actionInputs(a),
      }));
  }
  bindAction(
    instanceId: string,
    actorActionId: string,
    bindings: Record<string, string> = {},
  ) {
    const source = this.getActorActions(instanceId).find(
      (a) => a.id === actorActionId,
    );
    if (!source) throw new Error("请选择当前模型版本的演员动作");
    const id = crypto.randomUUID();
    this.updateConfiguration(instanceId, (i) => {
      const c = i.sceneMotion;
      if (!c) throw new Error("请先初始化地图绑定");
      if (c.schemaVersion === 1 && c.actions.length)
        throw new Error("请先将旧动作归入演员层");
      c.schemaVersion = 2;
      c.actions.push({
        id,
        name: source.name,
        actorActionId,
        actorActionUpdatedAt: source.updatedAt,
        bindings: structuredClone(bindings),
      });
      c.selectedActionId = id;
    });
    return id;
  }
  updateActionBinding(
    instanceId: string,
    id: string,
    bindings: Record<string, string>,
    refresh = false,
  ) {
    this.updateConfiguration(instanceId, (i) => {
      const a = i.sceneMotion?.actions.find((a) => a.id === id);
      if (!a || "plan" in a) throw new Error("地图动作引用不存在");
      a.bindings = structuredClone(bindings);
      if (refresh) {
        const source = this.actors
          .get(i.actorId)
          ?.motionActions?.find((source) => source.id === a.actorActionId);
        if (!source) throw new Error("演员动作不存在");
        a.actorActionUpdatedAt = source.updatedAt;
      }
    });
  }
  getCapabilities() {
    return {
      mapId: this.map?.id,
      instances: this.instances.map((i) => ({
        id: i.id,
        actorId: i.actorId,
        modelRevisionId: i.modelRevisionId,
        points: i.sceneMotion?.points ?? [],
        actions:
          i.sceneMotion?.actions.map((a) => ({ id: a.id, name: a.name })) ?? [],
        machine: i.sceneMotion?.machine ?? null,
        actorActions: this.getActorActions(i.id),
      })),
    };
  }
  async projectPoint(instanceId: string, point: Vec3) {
    const i = this.instance(instanceId);
    if (!i.sceneMotion) throw new Error("请先初始化场景动作");
    return (await this.navigation(i.sceneMotion.navigation)).project(point);
  }
  subscribe(listener: (e: ExecutionEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private advance(dt: number) {
    for (const [id, p] of this.executions) {
      p.runtime.advance(dt);
      if (p.runtime.frame) this.view.applySceneFrame(id, p.runtime.frame);
    }
    for (const machine of this.machines.values()) machine.advance(dt);
    if (this.executions.size) this.onChange();
  }
  pauseAll() {
    for (const machine of this.machines.values()) machine.pause();
    for (const id of this.executions.keys()) this.pauseAction(id);
  }
  cancelAll() {
    for (const id of new Set([
      ...this.executions.keys(),
      ...this.machines.keys(),
    ]))
      this.invalidate(id);
    this.onChange();
  }
  setStateMachine(instanceId: string, machine: CharacterMachine | null) {
    this.updateConfiguration(instanceId, (i) => {
      if (machine) i.sceneMotion!.machine = structuredClone(machine);
      else delete i.sceneMotion!.machine;
    });
  }
  getMachineState(instanceId: string): CharacterMachineState | null {
    return this.machines.get(instanceId)?.getState() ?? null;
  }
  subscribeMachine(
    listener: (instanceId: string, state: CharacterMachineState) => void,
  ) {
    this.machineListeners.add(listener);
    return () => {
      this.machineListeners.delete(listener);
    };
  }
  private createMachine(instanceId: string) {
    const config = this.instance(instanceId).sceneMotion;
    if (!config?.machine?.enabled) throw new Error("请先设置并启用角色状态机");
    validateSceneMotion(
      config,
      this.actors.get(this.instance(instanceId).actorId)!,
      this.instance(instanceId),
      this.map!.map,
    );
    this.machines.get(instanceId)?.stop();
    this.machines.delete(instanceId);
    const machine = new CharacterMachineRuntime(config.machine, {
      launch: async (actionId, initial, current) => {
        const state = initial ? null : this.getExecutionState(instanceId);
        const p = await this.prepareAction(
          instanceId,
          actionId,
          state
            ? {
                position: state.position,
                heading: state.heading,
              }
            : undefined,
        );
        if (current() && this.machines.get(instanceId) === machine)
          this.startPrepared(p, true);
      },
      actionStatus: () => this.getExecutionState(instanceId)?.status,
      pause: () => this.pauseAction(instanceId),
      resume: () => this.resumeAction(instanceId),
      interrupt: () => this.pauseAction(instanceId),
      changed: () => {
        for (const listener of this.machineListeners) {
          try {
            listener(instanceId, machine.getState());
          } catch {
            /* caller isolated */
          }
        }
        this.onChange();
      },
    });
    this.machines.set(instanceId, machine);
    return machine;
  }
  async startStateMachine(instanceId: string) {
    const machine = this.createMachine(instanceId);
    this.invalidateAction(instanceId);
    await machine.start();
    const state = machine.getState();
    if (state.status === "failed") throw new Error(state.error);
  }
  async switchState(instanceId: string, stateId: string) {
    let machine = this.machines.get(instanceId);
    if (!machine) {
      const config = this.instance(instanceId).sceneMotion?.machine;
      if (!config?.states.some((s) => s.id === stateId))
        throw new Error("角色状态不存在");
      machine = this.createMachine(instanceId);
    }
    await machine.start(stateId, !this.getExecutionState(instanceId));
    const state = machine.getState();
    if (state.status === "failed") throw new Error(state.error);
  }
  async playAll() {
    const ids = this.instances
      .filter((i) => i.sceneMotion?.machine?.enabled)
      .map((i) => i.id);
    if (!ids.length) throw new Error("请先为至少一个角色启用状态机");
    const results = await Promise.allSettled(
      ids.map(async (id) => {
        const state = this.getMachineState(id);
        if (state?.status === "paused") {
          this.resumeExecution(id);
          return Promise.resolve();
        }
        if (state && ["running", "starting", "waiting"].includes(state.status))
          return Promise.resolve();
        return this.startStateMachine(id);
      }),
    );
    const errors = results.flatMap((r, index) =>
      r.status === "rejected"
        ? [
            `${ids[index]}：${r.reason instanceof Error ? r.reason.message : r.reason}`,
          ]
        : [],
    );
    if (errors.length)
      throw new Error(`部分角色未能播放：${errors.join("；")}`);
  }
  private clear() {
    this.cancelAll();
    this.generation++;
    for (const { nav } of this.navigations.values()) nav.dispose();
    this.navigations.clear();
    this.view.setSceneGeometry(null);
    this.snapshot?.dispose();
    this.snapshot = null;
    this.geometry = null;
  }
  dispose() {
    this.clear();
    this.view.onSceneFrame = () => {};
    this.listeners.clear();
    this.machineListeners.clear();
  }
}
declare global {
  interface Window {
    lifetimeSceneMotion: SceneMotionPort;
  }
}
