/** Isolated browser QA, including a deterministic planner. Never calls a paid backend. */
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer as createHttpServer } from "node:http";
import { build } from "vite";
import { Store } from "../src/server/store";
import { createServer } from "../src/server/http";
import { revision, clip } from "./fixtures";
const dir = await mkdtemp(path.join(os.tmpdir(), "lifetime-motion-qa-"));
const store = new Store(path.join(dir, "data"));
const actor = await store.createActor("标点动作验证演员");
await store.appendModel(actor.id, revision);
await store.appendClip(actor.id, clip);
await store.appendClip(actor.id, {
  ...clip,
  id: "clip-replacement",
  name: "奔跑（占位测试动画）",
  createdAt: 3,
});
await store.saveMotionAction(actor.id, {
  id: "timeline-fixture",
  name: "时间段编辑验证",
  createdAt: 1,
  updatedAt: 1,
  modelRevisionId: revision.id,
  prompt: "",
  document: [
    { type: "animation", clipId: clip.id, modelRevisionId: revision.id },
  ],
  plan: {
    schemaVersion: 2,
    name: "时间段编辑验证",
    modelRevisionId: revision.id,
    start: [4, 0, 0],
    steps: [
      {
        id: "move",
        type: "moveTo",
        destination: [10, 0, 0],
        speed: 2,
        animation: { clipId: clip.id, repeat: "untilArrival" },
      },
      {
        id: "wave",
        type: "playClip",
        animation: { clipId: clip.id, repeat: 1 },
      },
    ],
  },
});
await build({
  build: { outDir: path.join(dir, "dist") },
  define: {
    "import.meta.env.VITE_GENERATION_API": JSON.stringify(
      "http://127.0.0.1:5293",
    ),
  },
});
const storage = createServer(store, path.join(dir, "dist"));
createHttpServer(async (req, res) => {
  if (req.url !== "/api/chat") {
    storage.emit("request", req, res);
    return;
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c);
  try {
    const request = JSON.parse(Buffer.concat(chunks).toString()),
      input = JSON.parse(request.messages[1].content);
    const points = input.points,
      c = input.capabilities;
    const result =
      points.length >= 2
        ? {
            schemaVersion: 2,
            name: "固定样本：经过标点",
            modelRevisionId: c.modelRevisionId,
            start: { point: points[0].id },
            steps: [
              {
                id: "arrive",
                type: "moveTo",
                destination: { point: points[1].id },
                speed: 2,
                path: {
                  mode: points.some((p: any) => p.position[1] > 0)
                    ? "air"
                    : "ground",
                },
                rootHeight: "path",
                animation: {
                  clipId: c.animations[0].clipId,
                  repeat: "untilArrival",
                },
              },
              {
                id: "wave",
                type: "playClip",
                animation: { clipId: c.animations[0].clipId, repeat: 1 },
              },
            ],
          }
        : { error: "测试规划器需要两个标点" };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, content: JSON.stringify(result) }));
  } catch {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "Invalid QA request" }));
  }
}).listen(5293, "127.0.0.1", () =>
  console.log(`QA http://127.0.0.1:5293/; mock planner; data ${dir}`),
);
