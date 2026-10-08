import { validateSceneMotion } from "../shared/sceneMotion";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Actor,
  ActionPool,
  AnimationClip,
  ModelRevision,
  Performance,
  ResourceSummary,
} from "../shared/contracts";
import type { MapResource } from "../shared/maps";
import { validateActorModel } from "../client/rendering/map/shared/actorModel";
import { decodeAnimation } from "../shared/animation";

import {
  validateAction,
  validatePoints,
  validateDocument,
  validateAnimationReferences,
  promptText,
  validatePool,
  type SavedAction,
} from "../shared/motion";

export type Collection = "actors" | "maps" | "performances";
export class Store {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private root: string) {}
  private file(kind: Collection, id: string): string {
    if (!/^[\w-]{1,100}$/.test(id)) throw new Error("无效资源 ID");
    return path.join(this.root, kind, `${id}.json`);
  }
  async get<T>(kind: Collection, id: string): Promise<T> {
    try {
      const value = JSON.parse(await readFile(this.file(kind, id), "utf8"));
      if (kind === "actors") {
        value.pools ??= structuredClone(value.actions ?? []);
        value.motionActions ??= [];
      }
      return value as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error("资源不存在");
      throw e;
    }
  }
  async list(kind: Collection): Promise<ResourceSummary[]> {
    await mkdir(path.join(this.root, kind), { recursive: true });
    const names = await readdir(path.join(this.root, kind));
    const docs = await Promise.all(
      names
        .filter((n) => n.endsWith(".json"))
        .map((n) => this.get<ResourceSummary>(kind, n.slice(0, -5))),
    );
    return docs
      .map(({ id, name, updatedAt }) => ({ id, name, updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  transaction<T>(work: () => Promise<T>): Promise<T> {
    const next = this.pending.then(work);
    this.pending = next.catch(() => {});
    return next;
  }
  private async write<T>(kind: Collection, id: string, value: T): Promise<T> {
    const file = this.file(kind, id);
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value));
    await rename(temp, file);
    return value;
  }
  createActor(name: string): Promise<Actor> {
    return this.transaction(() => {
      const actor: Actor = {
        id: randomUUID(),
        name: requiredName(name),
        updatedAt: Date.now(),
        modelRevisions: [],
        animations: [],
      };
      return this.write("actors", actor.id, actor);
    });
  }
  renameActor(id: string, name: string): Promise<Actor> {
    return this.transaction(async () => {
      const actor = await this.get<Actor>("actors", id);
      actor.name = requiredName(name);
      actor.updatedAt = Date.now();
      return this.write("actors", id, actor);
    });
  }
  appendModel(id: string, revision: ModelRevision): Promise<Actor> {
    return this.transaction(async () => {
      validateActorModel(revision.modelJson);
      this.file("actors", revision.id);
      const actor = await this.get<Actor>("actors", id);
      const old = actor.modelRevisions.find((r) => r.id === revision.id);
      if (old && JSON.stringify(old) !== JSON.stringify(revision))
        throw new Error("模型版本 ID 冲突");
      if (!old) actor.modelRevisions.push(revision);
      actor.updatedAt = Date.now();
      return this.write("actors", id, actor);
    });
  }
  appendClip(id: string, clip: AnimationClip): Promise<Actor> {
    return this.transaction(async () => {
      const actor = await this.get<Actor>("actors", id);
      const model = actor.modelRevisions.find(
        (r) => r.id === clip.modelRevisionId,
      );
      if (!model) throw new Error("动画必须绑定已有模型版本");
      this.file("actors", clip.id);
      const decoded = decodeAnimation(
        clip.format === "baked"
          ? { baked: clip.animation }
          : { plan: clip.animation },
        model.modelJson,
      );
      const value = { ...clip, ...decoded };
      const old = actor.animations.find((c) => c.id === value.id);
      if (old && JSON.stringify(old) !== JSON.stringify(value))
        throw new Error("动画 ID 冲突");
      if (!old) actor.animations.push(value);
      actor.updatedAt = Date.now();
      return this.write("actors", id, actor);
    });
  }
  saveAction(id: string, action: ActionPool): Promise<Actor> {
    return this.transaction(async () => {
      const actor = await this.get<Actor>("actors", id);
      this.file("actors", action.id);
      const name = requiredName(action.name);
      if (!actor.modelRevisions.some((r) => r.id === action.modelRevisionId))
        throw new Error("动作必须绑定已有模型版本");
      if (
        !Array.isArray(action.clipIds) ||
        !action.clipIds.length ||
        action.clipIds.length > 100 ||
        new Set(action.clipIds).size !== action.clipIds.length ||
        !action.clipIds.every((id) =>
          actor.animations.some(
            (c) => c.id === id && c.modelRevisionId === action.modelRevisionId,
          ),
        )
      )
        throw new Error("动作池只能使用当前模型版本的动画，且不能为空或重复");
      const actions = (actor.pools ??= []);
      const old = actions.find((a) => a.id === action.id);
      if (old && old.modelRevisionId !== action.modelRevisionId)
        throw new Error("不能改变动作的模型版本");
      const value: ActionPool = {
        id: action.id,
        name,
        modelRevisionId: action.modelRevisionId,
        clipIds: [...action.clipIds],
        ...(action.entries ? { entries: structuredClone(action.entries) } : {}),
        createdAt: old?.createdAt ?? Date.now(),
      };
      validatePool(value, actor);
      if (old) actions[actions.indexOf(old)] = value;
      else actions.push(value);
      // Keep legacy readers working without losing the original pool IDs.
      actor.actions = structuredClone(actions);
      for (const saved of actor.motionActions ?? [])
        if (saved.plan.poolId === value.id)
          validateAction(saved.plan, { actor, pool: value });
      actor.updatedAt = Date.now();
      return this.write("actors", id, actor);
    });
  }
  saveMotionAction(id: string, input: SavedAction): Promise<Actor> {
    return this.transaction(async () => {
      const actor = await this.get<Actor>("actors", id);
      this.file("actors", input.id);
      const pool = actor.pools?.find((p) => p.id === input.plan?.poolId);
      if (input.plan?.schemaVersion === 1 && !pool)
        throw new Error("旧动作的动画资源配置不存在");
      const points = input.points ?? [];
      validatePoints(points);
      const document = input.document ?? [
        {
          type: "text" as const,
          text: typeof input.prompt === "string" ? input.prompt : "",
        },
      ];
      const context = {
        actor,
        modelRevisionId: input.plan?.modelRevisionId,
        points,
        pool: input.plan?.schemaVersion === 1 ? pool : undefined,
      };
      validateDocument(document, points, context);
      const plan = validateAction(input.plan, {
        actor,
        pool: input.plan?.schemaVersion === 1 ? pool : undefined,
        modelRevisionId: input.plan?.modelRevisionId,
        points,
      });
      validateAnimationReferences(document, plan, context);
      const list = (actor.motionActions ??= []),
        old = list.find((a) => a.id === input.id);
      if (old && old.modelRevisionId !== plan.modelRevisionId)
        throw new Error("不能改变动作的模型版本");
      const value: SavedAction = {
        id: input.id,
        name: plan.name,
        modelRevisionId: plan.modelRevisionId,
        createdAt: old?.createdAt ?? Date.now(),
        updatedAt: Math.max(Date.now(), (old?.updatedAt ?? 0) + 1),
        prompt: promptText(document, points, context),
        document: structuredClone(document),
        points: structuredClone(points),
        plan,
      };
      if (old) list[list.indexOf(old)] = value;
      else list.push(value);
      actor.updatedAt = Date.now();
      return this.write("actors", id, actor);
    });
  }
  saveMap(
    resource: Omit<MapResource, "id" | "updatedAt">,
  ): Promise<MapResource> {
    return this.transaction(() => {
      const map = { ...resource, id: randomUUID(), updatedAt: Date.now() };
      return this.write("maps", map.id, map);
    });
  }
  savePerformance(draft: Performance): Promise<Performance> {
    return this.transaction(async () => {
      this.file("performances", draft.id);
      requiredName(draft.name);
      const map = await this.get<MapResource>("maps", draft.mapId);
      if (!Array.isArray(draft.instances) || draft.instances.length > 100)
        throw new Error("演员实例数量无效");
      const ids = new Set<string>();
      for (const item of draft.instances) {
        if (!item.id || ids.has(item.id)) throw new Error("演员实例 ID 重复");
        ids.add(item.id);
        if (
          !Array.isArray(item.position) ||
          item.position.length !== 3 ||
          !item.position.every(Number.isFinite) ||
          !Number.isFinite(item.rotation) ||
          !Number.isFinite(item.scale) ||
          item.scale <= 0 ||
          typeof item.loop !== "boolean"
        )
          throw new Error("演员实例变换无效");
        const actor = await this.get<Actor>("actors", item.actorId);
        if (!actor.modelRevisions.some((r) => r.id === item.modelRevisionId))
          throw new Error("演员实例引用不存在的模型版本");
        if (
          item.clipId &&
          !actor.animations.some(
            (c) =>
              c.id === item.clipId &&
              c.modelRevisionId === item.modelRevisionId,
          )
        )
          throw new Error("动画与演员模型版本不匹配");
        if (item.sceneMotion !== undefined)
          validateSceneMotion(item.sceneMotion, actor, item, map.map);
      }
      return this.write("performances", draft.id, {
        ...draft,
        updatedAt: Date.now(),
      });
    });
  }
}
function requiredName(value: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("名称不能为空");
  return value.trim().slice(0, 100);
}
