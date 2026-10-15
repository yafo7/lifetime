import { randomUUID } from "node:crypto";
import type {
  Actor,
  ActorInstance,
  Performance,
  ModelRevision,
  AnimationClip,
} from "../../shared/contracts";
import type { MapResource } from "../../shared/maps";
import { sceneCatalogue, currentScenePlan } from "../../shared/scenePlan";
import {
  validateBlueprint,
  resolveBlueprint,
  type SceneBlueprint,
} from "../../shared/sceneBlueprint";
import type {
  AssetTask,
  SceneGenerationRun,
  AssemblyDraft,
} from "../../shared/sceneBuild";
import { validateAction, validatePoints } from "../../shared/motion";
import { mapSpace } from "../../shared/sceneMotion";
import { decodeAnimation } from "../../shared/animation";
import {
  generateModel,
  generateAnimation,
  GenerationFailure,
} from "../../generation/client";
import { buildSemanticIndex } from "../../client/navigation/semanticIndex";
import { planBlueprint } from "./planner";
import { BuildJournal } from "./journal";
import type { Store } from "../store";
import { validateActorModel } from "../../client/rendering/map/shared/actorModel";
import {
  traversalAnimation,
  traversalClip,
  type TraversalKind,
} from "../../shared/traversal";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const stages: Record<string, string> = {
  thinking_start: "正在生成模型",
  generating: "正在生成模型",
  result: "模型结果已收到",
  complete: "模型结果已收到",
};
interface Options {
  api?: string;
  fetcher?: typeof fetch;
  planner?: typeof planBlueprint;
  model?: typeof generateModel;
  animation?: typeof generateAnimation;
  models?: number;
  animations?: number;
  total?: number;
  now?: () => number;
}
/** Durable generation orchestration. Spatial assembly remains in the browser. */
export class SceneGenerationService {
  readonly journal: BuildJournal;
  private runs = new Map<string, SceneGenerationRun>();
  private starting = new Set<string>();
  private active = new Map<
    string,
    { kind: AssetTask["kind"]; controller: AbortController }
  >();
  private initialized?: Promise<void>;
  private creating: Promise<unknown> = Promise.resolve();
  private checkpointQueue: Promise<unknown> = Promise.resolve();
  private volatileResults = new Map<string, Record<string, unknown>>();
  private closed = false;
  private pumping = false;
  private reschedule = false;
  private api: string;
  private now: () => number;
  constructor(
    private store: Store,
    private options: Options = {},
  ) {
    this.journal = new BuildJournal(store.buildDirectory);
    this.api =
      options.api ??
      process.env.LIFETIME_GENERATION_API ??
      process.env.VITE_GENERATION_API ??
      "https://voxel-studio-backend.zeabur.app";
    this.now = options.now ?? Date.now;
  }
  private publish(run: SceneGenerationRun) {
    run.updatedAt = this.now();
    return this.journal.write(run);
  }
  private initialize() {
    return (this.initialized ??= (async () => {
      for (const run of await this.journal.list()) {
        this.runs.set(run.id, run);
        if (run.phase === "planning") {
          run.phase = "failed";
          run.status = "上次规划已中断，可重新规划";
        }
        if (run.phase === "assembling") {
          run.phase = "assets-ready";
          delete run.lease;
          run.status = "素材已就绪，等待恢复地图装配";
        }
        for (const task of run.tasks) {
          const assets = run.manifest[task.roleKey];
          const actor = assets
            ? await this.store
                .get<Actor>("actors", assets.actorId)
                .catch(() => null)
            : null;
          const saved =
            task.kind === "model"
              ? actor?.modelRevisions.some(
                  (m) => m.id === assets.modelRevisionId,
                )
              : actor?.animations.some(
                  (c) => c.id === assets.animations[task.animationKey!],
                );
          if (saved && task.state !== "done") {
            task.state = "done";
            task.status = "已保存";
          } else if (["generating", "saving"].includes(task.state)) {
            task.state = (await this.journal.cached(task.id))
              ? "save-failed"
              : "uncertain";
            task.status =
              task.state === "save-failed"
                ? "结果已保留，可继续保存"
                : "服务已重启，远端结果待确认；未自动重发";
          }
        }
        if (["generating", "assets-ready", "failed"].includes(run.phase))
          await this.settle(run);
        await this.publish(run);
      }
      this.schedule();
    })());
  }
  async list(mapId?: string, purpose?: string) {
    await this.initialize();
    return structuredClone(
      [...this.runs.values()]
        .filter((r) => !mapId || r.mapId === mapId)
        .filter((r) =>
          purpose === "navigation-assets" ? r.purpose === purpose : !r.purpose,
        )
        .sort((a, b) => b.startedAt - a.startedAt),
    );
  }
  async get(id: string) {
    await this.initialize();
    const run = this.runs.get(id);
    if (!run) throw new Error("构建不存在");
    if (run.phase === "assembling" && run.lease!.until < this.now()) {
      run.phase = "assets-ready";
      delete run.lease;
      run.status = "装配连接已中断，可以继续";
      await this.publish(run);
    }
    return structuredClone(run);
  }
  private async actors() {
    return Promise.all(
      (await this.store.list("actors")).map((a) =>
        this.store.get<Actor>("actors", a.id),
      ),
    );
  }
  /** Uses the same durable queue/cache as scene builds, without chat or scene publication. */
  createTraversal(input: {
    base: Performance;
    instanceId: string;
    kinds: TraversalKind[];
  }): Promise<SceneGenerationRun> {
    const next = this.creating.then(async () => {
      await this.initialize();
      if (
        !Array.isArray(input.kinds) ||
        !input.kinds.length ||
        input.kinds.length > 2 ||
        input.kinds.some((kind) => !["jump", "fly"].includes(kind))
      )
        throw new Error("导航动画需求无效");
      await this.store.validatePerformance(input.base);
      const instance = input.base.instances.find(
        (i) => i.id === input.instanceId,
      );
      if (!instance) throw new Error("NPC 不存在");
      const actor = await this.store.get<Actor>("actors", instance.actorId);
      if (!actor.modelRevisions.some((m) => m.id === instance.modelRevisionId))
        throw new Error("模型版本不存在");
      if (input.kinds.includes("fly") && !instance.sceneMotion?.traversal?.fly)
        throw new Error("请先为角色开启飞行能力");
      const kinds = [...new Set(input.kinds)].sort() as TraversalKind[];
      const existing = [...this.runs.values()].find(
        (run) =>
          run.purpose === "navigation-assets" &&
          run.traversalAssets?.actorId === actor.id &&
          run.traversalAssets.modelRevisionId === instance.modelRevisionId &&
          JSON.stringify(run.traversalAssets.kinds) === JSON.stringify(kinds),
      );
      if (existing) return structuredClone(existing);
      const map = await this.store.get<MapResource>("maps", input.base.mapId);
      const id = randomUUID(),
        now = this.now();
      const run: SceneGenerationRun = {
        schemaVersion: 1,
        purpose: "navigation-assets",
        traversalAssets: {
          actorId: actor.id,
          modelRevisionId: instance.modelRevisionId,
          kinds,
        },
        id,
        mapId: map.id,
        mapRevision: map.updatedAt,
        base: structuredClone(input.base),
        request: `${actor.name}：补齐导航动画`,
        climb: instance.sceneMotion?.navigation.climb ?? 0.3,
        phase: "generating",
        status: "正在准备导航动画",
        startedAt: now,
        updatedAt: now,
        manifest: {
          navigation: {
            actorId: actor.id,
            modelRevisionId: instance.modelRevisionId,
            animations: {},
          },
        },
        tasks: [],
        blueprint: {
          schemaVersion: 1,
          name: "导航动画素材",
          actors: [
            {
              key: "navigation",
              name: actor.name,
              model: {
                source: "existing",
                actorId: actor.id,
                modelRevisionId: instance.modelRevisionId,
              },
              animations: [],
              origin: "",
              locations: [],
              actions: [],
              states: [],
              initialState: "",
            },
          ],
        },
      };
      run.tasks.push({
        id: randomUUID(),
        roleKey: "navigation",
        kind: "model",
        name: actor.name,
        description: "使用已有模型",
        state: "done",
        status: "已复用",
        attempts: 0,
        reused: true,
        updatedAt: now,
      });
      for (const kind of kinds) {
        const spec = traversalAnimation[kind],
          clip = traversalClip(actor, instance.modelRevisionId, kind);
        run.blueprint!.actors[0].animations.push(
          clip
            ? {
                key: kind,
                name: spec.name,
                source: "existing",
                clipId: clip.id,
              }
            : {
                key: kind,
                name: spec.name,
                source: "generate",
                description: spec.description,
                mode: "quick",
                loop: spec.loop,
              },
        );
        run.manifest.navigation.animations[kind] = clip?.id ?? randomUUID();
        run.tasks.push({
          id: randomUUID(),
          roleKey: "navigation",
          animationKey: kind,
          kind: "animation",
          name: `${actor.name} · ${spec.name}`,
          description: spec.description,
          state: clip ? "done" : "queued",
          status: clip ? "已复用" : "等待生成",
          attempts: 0,
          reused: !!clip,
          updatedAt: now,
        });
      }
      this.runs.set(id, run);
      await this.publish(run);
      await this.settle(run);
      await this.publish(run);
      this.schedule();
      return structuredClone(run);
    });
    this.creating = next.catch(() => {});
    return next;
  }
  private async catalogue(run: SceneGenerationRun) {
    const map = await this.store.get<MapResource>("maps", run.mapId);
    if (map.updatedAt !== run.mapRevision)
      throw new Error("地图已更新，请基于新地图重新构建；已生成素材保留");
    const actors = await this.actors();
    return sceneCatalogue(
      buildSemanticIndex(map).summary,
      actors,
      run.base.instances.map((i) => {
        const role = run.blueprint?.actors.find((r) => r.instanceId === i.id);
        const assets = role && run.manifest[role.key];
        return assets
          ? {
              ...i,
              actorId: assets.actorId,
              modelRevisionId: assets.modelRevisionId,
            }
          : i;
      }),
    );
  }
  create(input: {
    id: string;
    request: string;
    base: Performance;
    climb: number;
    blueprint?: unknown;
  }): Promise<SceneGenerationRun> {
    const next = this.creating.then(() => this.createOnce(input));
    this.creating = next.catch(() => {});
    return next;
  }
  private async createOnce(input: {
    id: string;
    request: string;
    base: Performance;
    climb: number;
    blueprint?: unknown;
  }) {
    await this.initialize();
    if (!/^[\w-]{1,100}$/.test(input.id)) throw new Error("无效构建标识");
    const already = this.runs.get(input.id);
    if (already) {
      if (
        already.request !== input.request ||
        JSON.stringify(already.base) !== JSON.stringify(input.base) ||
        already.climb !== input.climb
      )
        throw new Error("构建标识冲突");
      return structuredClone(already);
    }
    if (
      typeof input.request !== "string" ||
      !input.request.trim() ||
      input.request.length > 4000 ||
      !Number.isFinite(input.climb) ||
      input.climb < 0 ||
      input.climb > 5
    )
      throw new Error("要求或通行参数无效");
    if (
      [...this.runs.values()].some(
        (r) =>
          ["planning", "generating", "assembling"].includes(r.phase) &&
          r.mapId === input.base.mapId &&
          !r.purpose,
      )
    )
      throw new Error("这张地图已有进行中的构建");
    await this.store.validatePerformance(input.base);
    const map = await this.store.get<MapResource>("maps", input.base.mapId);
    const run: SceneGenerationRun = {
      schemaVersion: 1,
      id: input.id,
      mapId: map.id,
      mapRevision: map.updatedAt,
      base: structuredClone(input.base),
      request: input.request,
      climb: input.climb,
      phase: "planning",
      status: "正在分析要求与地图",
      tasks: [],
      manifest: {},
      startedAt: this.now(),
      updatedAt: this.now(),
    };
    this.runs.set(run.id, run);
    await this.publish(run);
    this.startPlan(run, input.blueprint);
    return structuredClone(run);
  }
  private startPlan(run: SceneGenerationRun, supplied?: unknown) {
    const controller = new AbortController();
    this.active.set(`plan-${run.id}`, { kind: "model", controller });
    void (async () => {
      try {
        const catalogue = await this.catalogue(run);
        const value =
          supplied ??
          (await (this.options.planner ?? planBlueprint)(
            run.request,
            catalogue,
            currentScenePlan(run.base),
            this.api,
            controller.signal,
            this.options.fetcher,
            async (content) => {
              run.planningResponse = content.slice(0, 200000);
              await this.publish(run);
            },
          ));
        if (run.phase === "cancelled" || this.closed) return;
        run.blueprint = validateBlueprint(value, catalogue);
        for (const role of run.blueprint.actors) {
          const generated = role.model.source === "generate";
          const owner =
            role.instanceId &&
            run.base.instances.find((i) => i.id === role.instanceId);
          const assets = (run.manifest[role.key] = {
            actorId:
              role.model.source === "generate"
                ? owner
                  ? owner.actorId
                  : randomUUID()
                : role.model.actorId,
            modelRevisionId:
              role.model.source === "generate"
                ? randomUUID()
                : role.model.modelRevisionId,
            animations: {} as Record<string, string>,
          });
          run.tasks.push({
            id: randomUUID(),
            roleKey: role.key,
            kind: "model",
            name: role.name,
            description:
              role.model.source === "generate"
                ? role.model.description
                : "使用已有模型",
            state: generated ? "queued" : "done",
            status: generated ? "等待生成" : "已复用",
            attempts: 0,
            reused: !generated,
            updatedAt: this.now(),
          });
          for (const a of role.animations) {
            assets.animations[a.key] =
              a.source === "existing" ? a.clipId : randomUUID();
            run.tasks.push({
              id: randomUUID(),
              roleKey: role.key,
              animationKey: a.key,
              kind: "animation",
              name: a.name,
              description:
                a.source === "generate" ? a.description : "使用已有动画",
              state:
                a.source === "existing"
                  ? "done"
                  : generated
                    ? "waiting"
                    : "queued",
              status:
                a.source === "existing"
                  ? "已复用"
                  : generated
                    ? "等待模型完成"
                    : "等待生成",
              attempts: 0,
              reused: a.source === "existing",
              updatedAt: this.now(),
            });
          }
        }
        run.phase = "generating";
        run.status = "正在准备角色与动画";
        await this.publish(run);
        await this.settle(run);
        this.schedule();
      } catch (e) {
        if (run.phase !== "cancelled") {
          run.phase = "failed";
          run.error = message(e);
          run.status = run.error;
          await this.publish(run);
        }
      } finally {
        this.active.delete(`plan-${run.id}`);
        this.schedule();
      }
    })().catch((e) => {
      run.error = message(e);
      run.status = `构建记录保存失败：${run.error}`;
    });
  }
  private schedule() {
    this.reschedule = true;
    if (!this.pumping && !this.closed) void this.pump();
  }
  private async pump() {
    this.pumping = true;
    try {
      while (this.reschedule && !this.closed) {
        this.reschedule = false;
        for (const run of this.runs.values()) {
          if (!run.blueprint || !["generating", "failed"].includes(run.phase))
            continue;
          for (const task of run.tasks) {
            if (
              task.state === "waiting" &&
              run.tasks.find(
                (t) => t.roleKey === task.roleKey && t.kind === "model",
              )?.state === "done"
            ) {
              task.state = "queued";
              task.status = "等待生成";
            }
            if (
              task.state !== "queued" ||
              this.starting.has(task.id) ||
              this.active.has(task.id)
            )
              continue;
            const active = [...this.active.values()];
            if (
              active.length + this.starting.size >= (this.options.total ?? 4) ||
              active.filter((t) => t.kind === task.kind).length >=
                (task.kind === "model"
                  ? (this.options.models ?? 2)
                  : (this.options.animations ?? 3))
            )
              continue;
            this.starting.add(task.id);
            void this.execute(run, task)
              .catch((e) => {
                run.error = message(e);
                run.status = `构建记录保存失败：${run.error}`;
              })
              .finally(() => {
                this.starting.delete(task.id);
                this.active.delete(task.id);
                this.schedule();
              });
          }
        }
      }
    } finally {
      this.pumping = false;
    }
  }
  private async execute(run: SceneGenerationRun, task: AssetTask) {
    const controller = new AbortController();
    this.active.set(task.id, { kind: task.kind, controller });
    this.starting.delete(task.id);
    let received = false;
    let invalid = false;
    const stoppedBeforeSubmission = () => {
      if (!this.closed && run.phase !== "cancelled") return false;
      if (task.state === "generating") task.attempts--;
      task.state = "queued";
      task.status = "已停止，等待继续";
      return true;
    };
    try {
      if (this.closed || run.phase === "cancelled") return;
      const role = run.blueprint!.actors.find((r) => r.key === task.roleKey)!,
        assets = run.manifest[role.key];
      let cached =
        (await this.journal.cached(task.id)) ??
        this.volatileResults.get(task.id);
      if (!cached) {
        if (stoppedBeforeSubmission()) return;
        task.state = "generating";
        task.status = "正在生成";
        task.attempts++;
        task.updatedAt = this.now();
        await this.publish(run);
        if (stoppedBeforeSubmission()) return;
        const options = {
          api: this.api,
          signal: controller.signal,
          fetcher: this.options.fetcher,
          onStage: (stage: string) => {
            task.status = stages[stage] ?? "后端正在生成";
            void this.publish(run).catch(() => {});
          },
        };
        let value: Record<string, unknown>;
        if (task.kind === "model") {
          value = await (this.options.model ?? generateModel)(
            (role.model as { description: string }).description,
            "gpt",
            "voxel-pro",
            options,
          );
        } else {
          const actor = await this.store.get<Actor>("actors", assets.actorId),
            model = actor.modelRevisions.find(
              (m) => m.id === assets.modelRevisionId,
            );
          if (!model) throw new Error("动画依赖的模型版本不存在");
          const requirement = role.animations.find(
            (a) => a.key === task.animationKey,
          )!;
          if (requirement.source !== "generate")
            throw new Error("动画任务无效");
          if (stoppedBeforeSubmission()) return;
          value = await (this.options.animation ?? generateAnimation)(
            model.modelJson,
            requirement.description,
            "gpt",
            requirement.mode,
            options,
          );
        }
        received = true;
        cached = { value, createdAt: this.now() };
        this.volatileResults.set(task.id, cached);
        await this.journal.cache(task.id, cached);
      }
      received = true;
      task.state = "saving";
      task.status = "校验并保存";
      await this.publish(run);
      const value = cached.value as Record<string, unknown>,
        createdAt = Number(cached.createdAt);
      if (task.kind === "model") {
        try {
          validateActorModel(value.modelJson);
        } catch (e) {
          invalid = true;
          throw e;
        }
        const revision: ModelRevision = {
          id: assets.modelRevisionId,
          createdAt,
          prompt: task.description,
          provider: "gpt",
          mode: "voxel-pro",
          modelJson: value.modelJson,
          metadata: value,
        };
        await this.store.createActor(role.name, assets.actorId);
        await this.store.appendModel(assets.actorId, revision);
      } else {
        const actor = await this.store.get<Actor>("actors", assets.actorId),
          model = actor.modelRevisions.find(
            (m) => m.id === assets.modelRevisionId,
          )!;
        let decoded: ReturnType<typeof decodeAnimation>;
        const requirement = role.animations.find(
          (a) => a.key === task.animationKey,
        )!;
        try {
          decoded = decodeAnimation(value, model.modelJson);
          if (
            requirement.source !== "generate" ||
            (requirement.loop &&
              !(decoded.animation as { loop?: boolean }).loop) ||
            (run.purpose === "navigation-assets" &&
              task.animationKey === "jump" &&
              !!(decoded.animation as { loop?: boolean }).loop)
          )
            throw new Error("后端返回的循环属性不符合动画要求，请重新生成此项");
        } catch (e) {
          invalid = true;
          throw e;
        }
        if (requirement.source !== "generate") throw new Error("动画任务无效");
        const clip: AnimationClip = {
          id: assets.animations[task.animationKey!],
          name: task.name,
          createdAt,
          prompt: task.description,
          provider: "gpt",
          mode: requirement.mode,
          modelRevisionId: model.id,
          ...decoded,
          metadata:
            run.purpose === "navigation-assets"
              ? { ...value, lifetimeTraversal: task.animationKey }
              : value,
        };
        await this.store.appendClip(actor.id, clip);
      }
      task.state = "done";
      task.status = "已保存";
      delete task.error;
      delete run.error;
      await this.publish(run);
      await this.journal.removeCache(task.id);
      this.volatileResults.delete(task.id);
    } catch (e) {
      const uncertain =
        !received &&
        (this.closed || (e instanceof GenerationFailure && e.uncertain));
      task.state = uncertain
        ? "uncertain"
        : received && !invalid
          ? "save-failed"
          : "failed";
      task.error = message(e);
      task.status = uncertain
        ? "连接已中断，远端结果待确认；未自动重发"
        : task.state === "save-failed"
          ? "保存失败，生成结果已保留"
          : message(e);
      run.error = task.status;
    } finally {
      task.updatedAt = this.now();
      await this.settle(run);
      await this.publish(run);
    }
  }
  private async settle(run: SceneGenerationRun) {
    if (
      !run.blueprint ||
      ["cancelled", "ready", "assembling"].includes(run.phase)
    )
      return;
    for (const task of run.tasks) {
      if (
        task.state === "waiting" &&
        run.tasks.some(
          (model) =>
            model.kind === "model" &&
            model.roleKey === task.roleKey &&
            model.state === "done",
        )
      ) {
        task.state = "queued";
        task.status = "等待生成";
      }
    }
    if (run.tasks.every((t) => t.state === "done")) {
      if (run.purpose === "navigation-assets") {
        run.phase = "ready";
        run.status = "导航动画已存入演员库";
        delete run.error;
        return;
      }
      try {
        const plan = resolveBlueprint(
          run.blueprint,
          run.manifest,
          await this.catalogue(run),
        );
        if (["ready", "assembling", "cancelled"].includes(run.phase)) return;
        run.plan = plan;
        run.phase = "assets-ready";
        run.status = "素材已就绪，等待地图装配";
        delete run.error;
      } catch (e) {
        if (["ready", "assembling", "cancelled"].includes(run.phase)) return;
        run.phase = "failed";
        run.error = message(e);
        run.status = run.error;
      }
    } else if (
      run.tasks.some((t) =>
        ["queued", "generating", "saving"].includes(t.state),
      )
    ) {
      run.phase = "generating";
      run.status = "正在生成角色与动画";
    } else {
      run.phase = "failed";
      run.status = "部分素材未完成，已完成的素材保留";
    }
  }
  async retry(id: string, taskId?: string) {
    await this.get(id);
    const run = this.runs.get(id)!;
    if (
      [...this.active.keys()].some((k) => k === `plan-${id}`) ||
      ["ready", "assembling"].includes(run.phase)
    )
      throw new Error("当前构建不能重试");
    if (!run.blueprint) {
      run.phase = "planning";
      delete run.error;
      await this.publish(run);
      this.startPlan(run);
      return structuredClone(run);
    }
    if (taskId) {
      const task = run.tasks.find((t) => t.id === taskId);
      if (!task || !["failed", "uncertain", "save-failed"].includes(task.state))
        throw new Error("此任务无需重试");
      if (task.state !== "save-failed") {
        const cached =
          (await this.journal.cached(task.id)) ??
          this.volatileResults.get(task.id);
        let valid = false;
        if (cached) {
          try {
            const value = cached.value as Record<string, unknown>;
            if (task.kind === "model") validateActorModel(value.modelJson);
            else {
              const assets = run.manifest[task.roleKey],
                actor = await this.store.get<Actor>("actors", assets.actorId);
              const decoded = decodeAnimation(
                value,
                actor.modelRevisions.find(
                  (m) => m.id === assets.modelRevisionId,
                )!.modelJson,
              );
              const requirement = run.blueprint.actors
                .find((r) => r.key === task.roleKey)!
                .animations.find((a) => a.key === task.animationKey)!;
              if (
                requirement.source !== "generate" ||
                (requirement.loop &&
                  !(decoded.animation as { loop?: boolean }).loop)
              )
                throw new Error("循环属性不匹配");
            }
            valid = true;
          } catch {}
        }
        if (!valid) {
          await this.journal.removeCache(task.id);
          this.volatileResults.delete(task.id);
        }
      }
      task.state =
        task.kind === "animation" &&
        run.tasks.find((t) => t.kind === "model" && t.roleKey === task.roleKey)
          ?.state !== "done"
          ? "waiting"
          : "queued";
      task.status = "等待执行";
      delete task.error;
    }
    run.phase = "generating";
    delete run.error;
    await this.settle(run);
    await this.publish(run);
    this.schedule();
    return structuredClone(run);
  }
  async cancel(id: string) {
    await this.get(id);
    const run = this.runs.get(id)!;
    if (run.phase === "ready") return structuredClone(run);
    run.phase = "cancelled";
    run.status = "已停止后续任务；已提交的素材继续接收并保存";
    delete run.lease;
    this.active.get(`plan-${id}`)?.controller.abort();
    await this.publish(run);
    return structuredClone(run);
  }
  async claim(id: string, owner: string, climb?: number) {
    await this.get(id);
    const run = this.runs.get(id)!;
    if (typeof owner !== "string" || !/^[\w-]{1,100}$/.test(owner))
      throw new Error("无效装配会话");
    if (run.phase === "assembling" && run.lease?.owner !== owner)
      throw new Error("另一个页面正在装配此场景");
    if (!["assets-ready", "assembling"].includes(run.phase) || !run.plan)
      throw new Error("素材尚未就绪");
    if (climb !== undefined) {
      if (!Number.isFinite(climb) || climb < 0 || climb > 5)
        throw new Error("通行参数无效");
      run.climb = climb;
    }
    run.lease = {
      owner,
      token: run.lease?.token ?? randomUUID(),
      until: this.now() + 300000,
    };
    run.phase = "assembling";
    run.status = "正在确定地图点、寻路和角色行为";
    await this.publish(run);
    return structuredClone(run);
  }
  async release(id: string, token: string, error: string) {
    await this.get(id);
    const run = this.runs.get(id)!;
    if (run.lease?.token !== token) throw new Error("装配会话已失效");
    run.phase = "assets-ready";
    run.status =
      error.slice(0, 1000) ||
      (run.assembly?.state === "ready"
        ? "地图检查通过，待完成并发布"
        : "空间草稿已保存，可以继续调整");
    if (error) run.error = run.status;
    else delete run.error;
    delete run.lease;
    await this.publish(run);
    return structuredClone(run);
  }
  checkpoint(
    id: string,
    token: string,
    expectedRevision: number,
    draft: AssemblyDraft,
  ) {
    const next = this.checkpointQueue.then(() =>
      this.saveCheckpoint(id, token, expectedRevision, draft),
    );
    this.checkpointQueue = next.catch(() => {});
    return next;
  }
  private async saveCheckpoint(
    id: string,
    token: string,
    expectedRevision: number,
    draft: AssemblyDraft,
  ) {
    await this.get(id);
    const run = this.runs.get(id)!;
    if (run.phase !== "assembling" || run.lease?.token !== token)
      throw new Error("装配会话已失效，请重新打开构建记录");
    if (expectedRevision !== (run.assembly?.revision ?? 0))
      throw new Error("空间草稿已被另一个页面修改，请重新打开");
    const map = await this.store.get<MapResource>("maps", run.mapId);
    if (map.updatedAt !== run.mapRevision)
      throw new Error("地图已更新，已保存素材保留，请基于新地图重新规划");
    if (
      !draft ||
      draft.schemaVersion !== 1 ||
      draft.revision !== expectedRevision ||
      draft.mapRevision !== run.mapRevision ||
      draft.planSignature !== JSON.stringify(run.plan) ||
      typeof draft.performanceId !== "string" ||
      !/^[\w-]{1,100}$/.test(draft.performanceId) ||
      !["working", "needs-repair", "ready"].includes(draft.state) ||
      !draft.roles ||
      JSON.stringify(draft).length > 3_000_000
    )
      throw new Error("空间草稿版本或内容无效");
    for (const [key, role] of Object.entries(draft.roles)) {
      const intended = run.plan!.actors.find((r) => r.key === key);
      if (
        !intended ||
        !role ||
        typeof role.instanceId !== "string" ||
        !/^[\w-]{1,100}$/.test(role.instanceId) ||
        !role.locations ||
        !role.actions ||
        !Array.isArray(role.issues)
      )
        throw new Error("空间草稿角色无效");
      let count = 0;
      for (const [locationKey, location] of Object.entries(role.locations)) {
        if (
          !location ||
          JSON.stringify(location.intent) !==
            JSON.stringify(
              intended.locations.find((l) => l.key === locationKey),
            ) ||
          !["pending", "ready", "needs-repair"].includes(location.state) ||
          typeof location.manual !== "boolean" ||
          typeof location.closed !== "boolean"
        )
          throw new Error("空间草稿地点意图无效");
        validatePoints(location.points, mapSpace(map.map));
        validatePoints(location.automatic, mapSpace(map.map));
        count += location.points.length;
      }
      const allPoints = Object.values(role.locations).flatMap((l) => l.points);
      if (
        new Set(allPoints.map((p) => p.id)).size !== allPoints.length ||
        new Set(allPoints.map((p) => p.name)).size !== allPoints.length
      )
        throw new Error("角色空间标点标识或名称重复");
      if (!role.checks || typeof role.checks !== "object")
        throw new Error("空间检查记录无效");
      if (
        role.instance &&
        (role.instance.id !== role.instanceId ||
          role.instance.actorId !== intended.actorId ||
          role.instance.modelRevisionId !== intended.modelRevisionId)
      )
        throw new Error("空间草稿演员引用无效");
      if (count > 20) throw new Error("角色空间标点超过20个");
      const actor = await this.store.get<Actor>("actors", intended.actorId);
      for (const [actionKey, action] of Object.entries(role.actions)) {
        if (
          !intended.actions.some((a) => a.key === actionKey) ||
          !action ||
          !["pending", "ready", "needs-repair"].includes(action.state)
        )
          throw new Error("空间草稿动作无效");
        if (
          typeof action.bindingId !== "string" ||
          !/^[\w-]{1,100}$/.test(action.bindingId) ||
          typeof action.signature !== "string" ||
          !action.bindings ||
          Object.values(action.bindings).some(
            (id) => !allPoints.some((p) => p.id === id),
          )
        )
          throw new Error("空间草稿动作标点引用无效");
        if (action.action)
          validateAction(action.action.plan, {
            actor,
            modelRevisionId: intended.modelRevisionId,
            points: action.action.points,
          });
      }
    }
    if (
      draft.state === "ready" &&
      run.plan!.actors.some((planned) => {
        const role = draft.roles[planned.key];
        return (
          !role?.instance ||
          !role.profile ||
          role.issues.length ||
          planned.locations.some(
            (l) => role.locations[l.key]?.state !== "ready",
          ) ||
          planned.actions.some((a) => !role.actions[a.key]?.action)
        );
      })
    )
      throw new Error("空间草稿尚未完成所有角色检查");
    const saved = structuredClone(draft);
    saved.revision = expectedRevision + 1;
    const updated = { ...run, assembly: saved, updatedAt: this.now() };
    if (run.phase !== "assembling" || run.lease?.token !== token)
      throw new Error("装配会话已失效");
    await this.journal.write(updated);
    run.assembly = saved;
    run.updatedAt = updated.updatedAt;
    return structuredClone(run);
  }
  async complete(id: string, token: string, draft: Performance) {
    await this.get(id);
    const run = this.runs.get(id)!;
    if (run.phase === "ready" && draft.id === run.performanceId)
      return this.store.get<Performance>("performances", draft.id);
    if (
      run.phase !== "assembling" ||
      run.lease?.token !== token ||
      draft.mapId !== run.mapId ||
      draft.id === run.base.id ||
      draft.sceneDesign?.request !== run.request
    )
      throw new Error("装配会话或演出引用无效");
    if (
      run.assembly &&
      (run.assembly.state !== "ready" ||
        run.assembly.performanceId !== draft.id)
    )
      throw new Error("空间草稿尚未通过完整检查");
    if (run.assembly) {
      const comparable = (instance: ActorInstance) => {
        const copy = structuredClone(instance);
        for (const binding of copy.sceneMotion?.actions ?? [])
          if ("actorActionUpdatedAt" in binding)
            binding.actorActionUpdatedAt = 0;
        return JSON.stringify(copy);
      };
      for (const role of Object.values(run.assembly.roles)) {
        const actual = draft.instances.find((i) => i.id === role.instanceId);
        if (
          !role.instance ||
          !actual ||
          role.issues.length ||
          comparable(actual) !== comparable(role.instance)
        )
          throw new Error("发布结果与已检查的空间草稿不一致，请重新检查");
      }
    }
    await this.catalogue(run);
    if (run.phase !== "assembling" || run.lease?.token !== token)
      throw new Error("装配会话已失效");
    const changed = new Set(run.plan!.actors.map((role) => role.instanceId));
    const removed = new Set(run.plan!.removeInstanceIds ?? []);
    for (const instance of run.base.instances) {
      const actual = draft.instances.find((item) => item.id === instance.id);
      if (removed.has(instance.id)) {
        if (actual) throw new Error("装配结果没有移除指定角色");
      } else if (
        !changed.has(instance.id) &&
        JSON.stringify(actual) !== JSON.stringify(instance)
      ) {
        throw new Error("装配结果修改了未涉及的角色");
      }
    }
    for (const planned of run.plan!.actors) {
      const actual = draft.sceneDesign!.plan.actors.find(
        (a) => a.key === planned.key,
      );
      const { instanceId: expectedId, ...expected } = planned;
      const { instanceId: actualId, ...resolved } = actual ?? {};
      if (
        !actual ||
        (expectedId && expectedId !== actualId) ||
        JSON.stringify(expected) !== JSON.stringify(resolved)
      )
        throw new Error("装配结果与指导文档不一致");
    }
    const result = await this.store.savePerformance(draft);
    run.performanceId = result.id;
    run.phase = "ready";
    run.status = "演出已保存，可以播放";
    delete run.error;
    delete run.lease;
    await this.publish(run);
    return result;
  }
  async close() {
    this.closed = true;
    for (const item of this.active.values()) item.controller.abort();
    for (let i = 0; i < 100 && this.active.size; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    await this.journal.flush();
  }
}
