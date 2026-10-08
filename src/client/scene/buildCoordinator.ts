import type { Actor, Performance } from "../../shared/contracts";
import type { MapResource } from "../../shared/maps";
import type { ScenePlan } from "../../shared/scenePlan";
import {
  sceneCatalogue,
  validateScenePlan,
  currentScenePlan,
} from "../../shared/scenePlan";
import { buildSemanticIndex } from "../navigation/semanticIndex";
import type { SceneGeometry } from "../navigation/geometry";
import type { Navigation } from "../navigation/navigation";
import type { NavigationProfile } from "../../shared/sceneMotion";
import { resources } from "../services/resources";
import { planScene } from "./planner";
import { assembleScene, type AssembledScene } from "./performanceAssembler";

export interface SceneBuildRecord {
  schemaVersion: 1;
  id: string;
  mapId: string;
  mapRevision: number;
  baseId: string;
  baseSignature: string;
  request: string;
  phase: "planning" | "building" | "saving" | "ready" | "failed" | "cancelled";
  status: string;
  plan?: ScenePlan;
  result?: AssembledScene;
  savedActions: string[];
  performanceId?: string;
  error?: string;
  warning?: string;
  startedAt: number;
}
export interface BuildContext {
  map: MapResource;
  base: Performance;
  actors: Map<string, Actor>;
  geometry: () => Promise<SceneGeometry>;
  navigation: (p: NavigationProfile) => Promise<Navigation>;
  current: () => boolean;
  climb: number;
}
export interface BuildStorage {
  read(): SceneBuildRecord | null;
  write(record: SceneBuildRecord): void;
}
export const buildStorage: BuildStorage = {
  read() {
    try {
      const r = JSON.parse(
        localStorage.getItem("lifetime.sceneBuild") ?? "null",
      );
      return r?.schemaVersion === 1 ? r : null;
    } catch {
      return null;
    }
  },
  write(record) {
    localStorage.setItem("lifetime.sceneBuild", JSON.stringify(record));
  },
};
/** One bounded planner request, then deterministic local assembly. No hidden generation retries. */
export class SceneBuildCoordinator {
  record: SceneBuildRecord | null;
  private controller: AbortController | null = null;
  onChange = () => {};
  constructor(
    private storage: BuildStorage = buildStorage,
    private api = resources,
    private planner = planScene,
  ) {
    this.record = storage.read();
    if (
      this.record &&
      ["planning", "building", "saving"].includes(this.record.phase)
    ) {
      this.record.phase = "failed";
      this.record.status = "上次构建已中断";
      this.record.error = this.record.result
        ? "结果已保留，可重试保存"
        : "可重试本地构建；没有计划时需重新规划";
    }
  }
  get busy() {
    return !!this.controller;
  }
  private publish() {
    if (this.record) {
      delete this.record.warning;
      try {
        this.storage.write(this.record);
      } catch {
        this.record.warning =
          "构建记录写入失败，刷新后无法保证恢复；请先完成保存";
      }
      this.onChange();
    }
  }
  cancel() {
    this.controller?.abort();
    if (this.record && this.busy) {
      this.record.phase = "cancelled";
      this.record.status = "已停止等待；不自动重发请求";
      this.publish();
    }
  }
  async run(
    request: string,
    context: BuildContext,
    reusePlan = false,
    providedPlan?: unknown,
  ) {
    if (this.busy) throw new Error("已有场景构建正在进行");
    const previous = this.record;
    if (typeof request !== "string" || request.length > 4000)
      throw new Error("场景要求须在4000字以内");
    if (
      reusePlan &&
      (!previous?.plan ||
        previous.mapId !== context.map.id ||
        previous.mapRevision !== context.map.updatedAt ||
        previous.baseSignature !== JSON.stringify(context.base))
    )
      throw new Error("没有当前草稿的可恢复计划，请打开原演出或重新规划");
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.record = reusePlan
      ? {
          ...previous!,
          phase: previous!.result ? "saving" : "building",
          error: undefined,
        }
      : {
          schemaVersion: 1,
          id: crypto.randomUUID(),
          mapId: context.map.id,
          mapRevision: context.map.updatedAt,
          baseId: context.base.id,
          baseSignature: JSON.stringify(context.base),
          request,
          phase: "planning",
          status: "正在规划场景",
          savedActions: [],
          startedAt: Date.now(),
        };
    const record = this.record,
      check = () => {
        if (signal.aborted) throw new Error("场景构建已取消");
        if (!context.current())
          throw new Error("当前演出已修改或地图已切换；构建未覆盖这些更改");
      };
    this.publish();
    try {
      const latestMap = await this.api.map(context.map.id);
      if (latestMap.updatedAt !== context.map.updatedAt)
        throw new Error("地图资源已更新，请重新打开后规划");
      const catalogue = sceneCatalogue(
        buildSemanticIndex(context.map).summary,
        [...context.actors.values()],
        context.base.instances,
      );
      if (!record.plan) {
        record.plan =
          providedPlan === undefined
            ? await this.planner(request, catalogue, {
                signal,
                previous: currentScenePlan(context.base),
              })
            : validateScenePlan(providedPlan, catalogue);
        check();
        this.publish();
      } else record.plan = validateScenePlan(record.plan, catalogue);
      if (!record.result) {
        record.phase = "building";
        record.status = "正在确定地图位置";
        this.publish();
        const geometry = await context.geometry();
        check();
        record.result = await assembleScene(record.plan, {
          ...context,
          map: context.map,
          request: record.request,
          geometry,
          signal,
          stage: (status) => {
            record.status = status;
            this.publish();
          },
        });
        check();
        this.publish();
      }
      record.phase = "saving";
      record.status = "正在保存演员动作与演出";
      this.publish();
      check();
      for (const entry of record.result.actions) {
        check();
        let actor: Actor;
        const comparable = (a: typeof entry.action) =>
          JSON.stringify({
            name: a.name,
            modelRevisionId: a.modelRevisionId,
            document: a.document,
            points: a.points,
            plan: a.plan,
          });
        if (record.savedActions.includes(entry.action.id))
          actor = await this.api.actor(entry.actorId);
        else {
          actor = await this.api.actor(entry.actorId);
          check();
          const already = actor.motionActions?.find(
            (a) => a.id === entry.action.id,
          );
          if (already) {
            if (comparable(already) !== comparable(entry.action))
              throw new Error("恢复的演员动作已被修改，请重新构建");
          } else
            actor = await this.api.saveMotionAction(
              entry.actorId,
              entry.action,
            );
          record.savedActions.push(entry.action.id);
        }
        const saved = actor.motionActions?.find(
          (a) => a.id === entry.action.id,
        );
        if (!saved) throw new Error("已保存的演员动作不存在");
        if (comparable(saved) !== comparable(entry.action))
          throw new Error("已保存的演员动作发生变化，请重新构建");
        for (const i of record.result.performance.instances)
          for (const a of i.sceneMotion?.actions ?? [])
            if ("actorActionId" in a && a.actorActionId === saved.id)
              a.actorActionUpdatedAt = saved.updatedAt;
        this.publish();
      }
      check();
      const mapBeforeSave = await this.api.map(context.map.id);
      if (mapBeforeSave.updatedAt !== record.mapRevision)
        throw new Error("地图已更新，旧构建结果不能应用");
      check();
      const result = await this.api.savePerformance(record.result.performance);
      record.result.performance = result;
      record.performanceId = result.id;
      record.phase = "ready";
      record.status = "演出已保存，可以播放";
      this.publish();
      return result;
    } catch (error) {
      record.phase = signal.aborted ? "cancelled" : "failed";
      record.error = error instanceof Error ? error.message : String(error);
      record.status =
        record.phase === "cancelled" ? "已取消构建" : record.error;
      this.publish();
      throw error;
    } finally {
      this.controller = null;
      this.onChange();
    }
  }
}
