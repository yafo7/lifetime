import type {
  SceneGenerationRun,
  AssemblyDraft,
} from "../../shared/sceneBuild";
import type { Performance } from "../../shared/contracts";
import { resources } from "../services/resources";
import { SceneBuildCoordinator, type BuildContext } from "./buildCoordinator";

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
  if (!response.ok)
    throw new Error(value.error || `构建服务失败（${response.status}）`);
  return value;
}
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 1000));
/** A browser observes durable jobs; generation survives page reloads. */
export class GenerationCoordinator {
  record: SceneGenerationRun | null = null;
  history: SceneGenerationRun[] = [];
  unsavedAssembly: { id: string; draft: AssemblyDraft } | null = null;
  onChange = () => {};
  onReady = () => {};
  private waiting = false;
  private disposed = false;
  private assembly: SceneBuildCoordinator | null = null;
  private owner: string;
  private recoveryVersion = 0;
  private pendingSubmission: { id: string; signature: string } | null = null;
  constructor() {
    this.owner =
      sessionStorage.getItem("lifetime.assemblyOwner") ?? crypto.randomUUID();
    sessionStorage.setItem("lifetime.assemblyOwner", this.owner);
  }
  get busy() {
    return (
      this.waiting ||
      (!!this.record &&
        ["planning", "generating", "assembling"].includes(this.record.phase))
    );
  }
  private update(record: SceneGenerationRun | null) {
    const changed = JSON.stringify(record) !== JSON.stringify(this.record);
    this.record = record;
    if (record) {
      this.history = [
        record,
        ...this.history.filter((r) => r.id !== record.id),
      ].sort((a, b) => b.startedAt - a.startedAt);
    }
    if (changed) this.onChange();
  }
  async recover(mapId: string) {
    const version = ++this.recoveryVersion;
    const list = await call<SceneGenerationRun[]>(
      `?mapId=${encodeURIComponent(mapId)}`,
    );
    if (version === this.recoveryVersion && !this.waiting) {
      this.history = list;
      const remembered = sessionStorage.getItem(
        `lifetime.buildSelection:${mapId}`,
      );
      this.update(list.find((r) => r.id === remembered) ?? list[0] ?? null);
    }
  }
  async select(id: string) {
    if (this.busy) throw new Error("请先等待当前构建完成");
    const next = await call<SceneGenerationRun>(`/${id}`);
    if (this.record && next.mapId !== this.record.mapId)
      throw new Error("构建属于其他地图");
    sessionStorage.setItem(`lifetime.buildSelection:${next.mapId}`, id);
    this.update(next);
  }
  async saveDraft(draft: AssemblyDraft) {
    if (!this.record || this.busy) throw new Error("请等待当前构建完成");
    this.waiting = true;
    this.onChange();
    let token: string | undefined;
    try {
      const run = await call<SceneGenerationRun>(`/${this.record.id}/claim`, {
        owner: this.owner,
      });
      token = run.lease!.token;
      const next = await call<SceneGenerationRun>(`/${run.id}/checkpoint`, {
        token,
        expectedRevision: draft.revision,
        draft,
      });
      this.update(
        await call<SceneGenerationRun>(`/${run.id}/release`, {
          token,
          error: "",
        }),
      );
      // A changed point invalidates the browser's old fully assembled result.
      localStorage.removeItem(`lifetime.sceneAssembly:${next.id}`);
      this.unsavedAssembly = null;
      return this.record!.assembly!;
    } catch (error) {
      if (token)
        await call<SceneGenerationRun>(`/${this.record.id}/release`, {
          token,
          error: "草稿保存失败，请保留调整后重试",
        })
          .then((record) => this.update(record))
          .catch(() => {});
      throw error;
    } finally {
      this.waiting = false;
      this.onChange();
    }
  }
  async check(context: BuildContext) {
    if (!this.record || this.busy) throw new Error("请等待当前构建完成");
    this.waiting = true;
    this.onChange();
    try {
      await this.assemble({ ...context, publish: false });
    } finally {
      this.waiting = false;
      this.onChange();
    }
  }
  async observe() {
    if (!this.record || this.waiting || this.disposed) return;
    const id = this.record.id;
    const record = await call<SceneGenerationRun>(`/${id}`);
    if (this.record?.id === id) {
      const becameReady =
        this.record.phase === "generating" && record.phase === "assets-ready";
      this.update(record);
      if (becameReady) this.onReady();
    }
  }
  async run(
    request: string,
    context: BuildContext,
    retry = false,
    blueprint?: unknown,
  ): Promise<Performance> {
    if (this.waiting) throw new Error("正在构建，请稍候");
    this.waiting = true;
    this.onChange();
    try {
      const signature = JSON.stringify({
        request,
        base: context.base,
        climb: context.climb,
        blueprint,
      });
      if (!retry && this.pendingSubmission?.signature !== signature)
        this.pendingSubmission = { id: crypto.randomUUID(), signature };
      const record =
        retry && this.record
          ? await call<SceneGenerationRun>(`/${this.record.id}/retry`, {})
          : await call<SceneGenerationRun>("", {
              id: this.pendingSubmission!.id,
              request,
              base: context.base,
              climb: context.climb,
              ...(blueprint === undefined ? {} : { blueprint }),
            });
      this.pendingSubmission = null;
      this.update(record);
      while (!this.disposed) {
        const next = await call<SceneGenerationRun>(`/${record.id}`);
        this.update(next);
        if (["failed", "cancelled"].includes(next.phase))
          throw new Error(next.error || next.status);
        if (next.phase === "ready")
          return resources.performance(next.performanceId!);
        if (
          next.phase === "assets-ready" ||
          (next.phase === "assembling" && next.lease?.owner === this.owner)
        ) {
          if (!context.current())
            throw new Error("素材已保留，当前地图或草稿已变化；可继续原构建");
          return await this.assemble(context);
        }
        await pause();
      }
      throw new Error("页面已关闭，素材生成由本地服务继续执行");
    } finally {
      this.waiting = false;
      this.onChange();
    }
  }
  private async assemble(context: BuildContext): Promise<Performance> {
    if (this.unsavedAssembly?.id === this.record?.id)
      throw new Error("空间计算结果尚未保存，请打开空间草稿后保存或取消调整");
    const run = await call<SceneGenerationRun>(`/${this.record!.id}/claim`, {
      owner: this.owner,
      climb: context.climb,
    });
    this.update(run);
    const key = `lifetime.sceneAssembly:${run.id}`,
      token = run.lease!.token;
    // Durable assembly checkpoints are authoritative across tabs and reloads.
    // Never publish a browser-cached result against a newer server draft.
    localStorage.removeItem(key);
    const storage = { read: () => null, write: () => {} };
    this.assembly = new SceneBuildCoordinator(storage, {
      ...resources,
      savePerformance: (performance: Performance) =>
        call<Performance>(`/${run.id}/complete`, { token, performance }),
    });
    this.assembly.onChange = () => {
      if (this.record?.id === run.id && this.assembly?.record) {
        this.record.status = this.assembly.record.status;
        this.onChange();
      }
    };
    const heartbeat = setInterval(() => {
      void call<SceneGenerationRun>(`/${run.id}/claim`, {
        owner: this.owner,
      }).catch(() => {});
    }, 30000);
    try {
      const actors = new Map(
        (
          await Promise.all(
            (await resources.list("actors")).map((a) => resources.actor(a.id)),
          )
        ).map((a) => [a.id, a]),
      );
      const input = {
        ...context,
        actors,
        base: run.base,
        climb: context.climb,
        assembly: run.assembly,
        checkpoint: async (draft: AssemblyDraft) => {
          this.unsavedAssembly = { id: run.id, draft: structuredClone(draft) };
          const next = await call<SceneGenerationRun>(`/${run.id}/checkpoint`, {
            token,
            expectedRevision: draft.revision,
            draft,
          });
          draft.revision = next.assembly!.revision;
          this.unsavedAssembly = null;
          this.update(next);
        },
      };
      const result = await this.assembly.run(
        run.request,
        input,
        !!this.assembly.record?.plan,
        run.plan,
      );
      if (context.publish === false) {
        this.update(
          await call<SceneGenerationRun>(`/${run.id}/release`, {
            token,
            error: "",
          }),
        );
        return result;
      }
      this.update(await call<SceneGenerationRun>(`/${run.id}`));
      return result;
    } catch (e) {
      this.update(
        await call<SceneGenerationRun>(`/${run.id}/release`, {
          token,
          error: e instanceof Error ? e.message : String(e),
        }).catch(() => this.record!),
      );
      throw e;
    } finally {
      clearInterval(heartbeat);
      this.assembly = null;
    }
  }
  async retryTask(taskId: string) {
    if (!this.record) return;
    this.update(
      await call<SceneGenerationRun>(`/${this.record.id}/retry`, { taskId }),
    );
  }
  async cancel() {
    this.assembly?.cancel();
    if (this.record)
      this.update(
        await call<SceneGenerationRun>(`/${this.record.id}/cancel`, {}),
      );
  }
  dispose() {
    this.disposed = true;
    this.assembly?.cancel();
    const run = this.record;
    if (run?.phase === "assembling" && run.lease?.owner === this.owner) {
      void fetch(`/api/builds/${run.id}/release`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: run.lease.token,
          error: "页面已关闭，素材保留，等待继续装配",
        }),
        keepalive: true,
      }).catch(() => {});
    }
  }
}
