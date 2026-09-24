import { describe, it, expect, vi } from "vitest";
import {
  generateModel,
  generateAnimation,
} from "../src/client/services/generation";
import { Jobs } from "../src/client/services/jobs";
import { modelJson, baked } from "./fixtures";
describe("backend integration", () => {
  it("surfaces a backend SSE error instead of treating the stream as success", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          'event: error\ndata: {"stage":"error","errorCode":"GENERATION_FAILED"}\n\n',
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    await expect(
      generateModel("robot", "gpt", "voxel-pro", { fetcher }),
    ).rejects.toThrow("GENERATION_FAILED");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("cancels waiting without saving an unknown external result", async () => {
    const jobs = new Jobs(),
      save = vi.fn();
    const running = jobs.run(
      "actor-a",
      "model",
      (signal) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("Aborted"))),
        ),
      save,
    );
    jobs.items[0].controller.abort();
    await running;
    expect(save).not.toHaveBeenCalled();
    expect(jobs.items[0].status).toContain("后端可能仍在执行");
  });
  it("decodes UTF-8 SSE across chunk boundaries and preserves metadata", async () => {
    const text = `event: thinking_start\r\ndata: {"stage":"thinking_start"}\r\n\r\nevent: result\r\ndata: ${JSON.stringify({ modelJson, stage: "result", label: "机器人" })}\r\n\r\n`;
    const bytes = new TextEncoder().encode(text);
    const stages: string[] = [];
    const fetcher = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let i = 0; i < bytes.length; i += 7)
                controller.enqueue(bytes.slice(i, i + 7));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    const result = await generateModel("robot", "gpt", "voxel-pro", {
      fetcher,
      onStage: (s) => stages.push(s),
    });
    expect(result.modelJson).toEqual(modelJson);
    expect(stages).toEqual(["thinking_start", "result"]);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("surfaces interrupted responses and never retries generation implicitly", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response('data: {"stage":"thinking_start"}\n\n', {
          headers: { "Content-Type": "text/event-stream" },
        }),
    );
    await expect(
      generateModel("robot", "gpt", "voxel-pro", { fetcher }),
    ).rejects.toThrow("未收到");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("uses unified animation endpoint with full model and no requested duration", async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true, baked }));
    await generateAnimation(modelJson, "挥手", "gpt", "quick", { fetcher });
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/api/generate/animation");
    const body = JSON.parse(init.body as string);
    expect(body.modelJson).toEqual(modelJson);
    expect(body.duration).toBeUndefined();
    expect(body.emitParticles).toBe(false);
  });
  it("retries only persistence and retains the submitted owner after UI switches", async () => {
    const jobs = new Jobs(),
      generate = vi.fn(async () => ({ model: "original" })),
      save = vi
        .fn()
        .mockRejectedValueOnce(new Error("disk unavailable"))
        .mockResolvedValueOnce(undefined);
    await jobs.run("actor-a", "模型", generate, save);
    expect(jobs.items[0].state).toBe("save-failed");
    expect(jobs.items[0].actorId).toBe("actor-a");
    await jobs.items[0].retry!();
    expect(generate).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledTimes(2);
    expect(jobs.items[0].state).toBe("done");
  });
});
