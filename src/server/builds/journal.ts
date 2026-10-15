import { mkdir, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { SceneGenerationRun } from "../../shared/sceneBuild";
import { atomicWrite } from "../atomicWrite";

/** Journals reference assets; large backend results have their own recovery files. */
export class BuildJournal {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private root: string) {}
  private file(id: string) {
    if (!/^[\w-]{1,100}$/.test(id)) throw new Error("无效构建标识");
    return path.join(this.root, `${id}.json`);
  }
  async list(): Promise<SceneGenerationRun[]> {
    await mkdir(this.root, { recursive: true });
    return Promise.all(
      (await readdir(this.root))
        .filter(
          (name) => /^[\w-]+\.json$/.test(name) && !name.startsWith("result_"),
        )
        .map(async (name) =>
          JSON.parse(await readFile(path.join(this.root, name), "utf8")),
        ),
    );
  }
  async get(id: string): Promise<SceneGenerationRun> {
    return JSON.parse(await readFile(this.file(id), "utf8"));
  }
  write(run: SceneGenerationRun) {
    return this.writeJson(run.id, run);
  }
  private writeJson(id: string, value: unknown) {
    const file = this.file(id),
      json = JSON.stringify(value);
    const next = this.pending.then(async () => {
      await mkdir(this.root, { recursive: true });
      await atomicWrite(file, json);
    });
    this.pending = next.catch(() => {});
    return next;
  }
  cache(taskId: string, value: unknown) {
    return this.writeJson(`result_${taskId}`, value);
  }
  async cached(taskId: string): Promise<Record<string, unknown> | null> {
    try {
      return JSON.parse(await readFile(this.file(`result_${taskId}`), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  async removeCache(taskId: string) {
    await unlink(this.file(`result_${taskId}`)).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
  async flush() {
    await this.pending;
  }
}
