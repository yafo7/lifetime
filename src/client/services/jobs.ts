export interface Job {
  id: string;
  label: string;
  actorId: string;
  startedAt: number;
  status: string;
  state: "running" | "saving" | "save-failed" | "done" | "failed";
  controller: AbortController;
  retry?: () => Promise<void>;
}
export class Jobs {
  readonly items: Job[] = [];
  onChange = () => {};
  async run<T>(
    actorId: string,
    label: string,
    generate: (signal: AbortSignal, stage: (s: string) => void) => Promise<T>,
    save: (value: T) => Promise<void>,
  ): Promise<void> {
    const job: Job = {
      id: crypto.randomUUID(),
      actorId,
      label,
      startedAt: Date.now(),
      status: "等待后端",
      state: "running",
      controller: new AbortController(),
    };
    this.items.push(job);
    this.onChange();
    try {
      const value = await generate(job.controller.signal, (status) => {
        job.status = status;
        this.onChange();
      });
      const persist = async () => {
        job.state = "saving";
        job.status = "正在保存";
        this.onChange();
        try {
          await save(value);
          job.state = "done";
          job.status = "已保存";
          job.retry = undefined;
        } catch (error) {
          job.state = "save-failed";
          job.status = `生成结果仍在内存中，保存失败：${message(error)}`;
          job.retry = persist;
        }
        this.onChange();
      };
      await persist();
    } catch (error) {
      job.state = "failed";
      job.status = job.controller.signal.aborted
        ? "已停止等待；后端可能仍在执行，请确认后再生成"
        : message(error);
      this.onChange();
    }
  }
  get busy(): boolean {
    return this.items.some(
      (j) =>
        j.state === "running" ||
        j.state === "saving" ||
        j.state === "save-failed",
    );
  }
}
export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
