import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Actor,
  AnimationClip,
  ModelRevision,
  Performance,
  ResourceSummary,
} from "../shared/contracts";
import type { MapResource } from "../shared/maps";
import { validateActorModel } from "../client/rendering/map/shared/actorModel";
import { decodeAnimation } from "../shared/animation";

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
      return JSON.parse(await readFile(this.file(kind, id), "utf8")) as T;
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
      await this.get("maps", draft.mapId);
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
