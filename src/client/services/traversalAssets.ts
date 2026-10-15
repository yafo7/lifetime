import type { Actor, Performance } from "../../shared/contracts";
import type { SceneGenerationRun } from "../../shared/sceneBuild";
import type { TraversalKind } from "../../shared/traversal";
import { resources } from "./resources";

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    `/api/builds${path}`,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "导航动画任务失败");
  return value;
}
/** Explicit playback creates durable jobs. Inspecting or dragging a path never calls this. */
export class TraversalAssets {
  records: SceneGenerationRun[] = [];
  onChange = () => {};
  private disposed = false;
  private currentMap = "";
  private pending = new Map<string, Promise<Actor>>();
  private update(record: SceneGenerationRun) {
    if (this.currentMap !== record.mapId) return;
    this.records = [record, ...this.records.filter((r) => r.id !== record.id)];
    this.onChange();
  }
  async recover(mapId: string) {
    this.currentMap = mapId;
    this.records = [];
    this.onChange();
    const records = await call<SceneGenerationRun[]>(
      `?mapId=${encodeURIComponent(mapId)}&purpose=navigation-assets`,
    );
    if (this.currentMap === mapId) {
      this.records = records;
      this.onChange();
    }
  }
  async observe() {
    const mapId = this.currentMap;
    for (const record of this.records.filter((r) => r.phase === "generating")) {
      const next = await call<SceneGenerationRun>(`/${record.id}`);
      if (mapId !== this.currentMap || this.disposed) return;
      if (JSON.stringify(record) !== JSON.stringify(next)) this.update(next);
    }
  }
  ensure(
    base: Performance,
    instanceId: string,
    kinds: TraversalKind[],
  ): Promise<Actor> {
    const instance = base.instances.find((i) => i.id === instanceId)!;
    const key = JSON.stringify([
      instance.actorId,
      instance.modelRevisionId,
      [...kinds].sort(),
    ]);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const work = (async () => {
      for (const kind of [...new Set(kinds)])
        await this.run(base, instanceId, [kind]);
      return resources.actor(instance.actorId);
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    return work;
  }
  private async run(
    base: Performance,
    instanceId: string,
    kinds: TraversalKind[],
  ) {
    let record = await call<SceneGenerationRun>("/traversal", {
      base,
      instanceId,
      kinds,
    });
    while (!this.disposed) {
      this.update(record);
      if (record.phase === "ready")
        return resources.actor(record.traversalAssets!.actorId);
      if (["failed", "cancelled"].includes(record.phase))
        throw new Error(
          "导航动画尚未完成；已生成结果保留，请在导航动画任务中处理失败项后重新播放",
        );
      await new Promise((resolve) => setTimeout(resolve, 1000));
      record = await call<SceneGenerationRun>(`/${record.id}`);
    }
    throw new Error("页面已关闭，动画任务继续由本地服务保存");
  }
  async retry(runId: string, taskId: string) {
    let record = await call<SceneGenerationRun>(`/${runId}/retry`, { taskId });
    while (!this.disposed) {
      this.update(record);
      if (!["generating", "planning"].includes(record.phase)) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      record = await call<SceneGenerationRun>(`/${runId}`);
    }
  }
  dispose() {
    this.disposed = true;
  }
}
