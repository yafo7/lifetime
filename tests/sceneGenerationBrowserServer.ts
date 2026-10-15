/** Real map/actor copies with a local deterministic generation backend. No paid requests. */
import { copyFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { build } from "vite";
import { Store } from "../src/server/store";
import { createServer } from "../src/server/http";
import { SceneGenerationService } from "../src/server/builds/service";
import type { Actor } from "../src/shared/contracts";
import type { SceneBlueprint } from "../src/shared/sceneBlueprint";

const dir = await mkdtemp(path.join(os.tmpdir(), "lifetime-generation-qa-"));
for (const kind of ["actors", "maps", "performances"])
  await mkdir(path.join(dir, "data", kind), { recursive: true });
const actorId = "ad884db6-3f98-4402-9bf5-a28293a4bbd3",
  mapId = "139a63d1-44bf-4bbf-a2f4-b5e705e3ad36";
await copyFile(
  `data/actors/${actorId}.json`,
  path.join(dir, "data/actors", `${actorId}.json`),
);
await copyFile(
  `data/maps/${mapId}.json`,
  path.join(dir, "data/maps", `${mapId}.json`),
);
const original: Actor = JSON.parse(
  await readFile(`data/actors/${actorId}.json`, "utf8"),
);
const clips = {
  run: original.animations.find(
    (c) => c.id === "45fe5d8a-40ab-4eb3-baaa-149fdc380f6e",
  )!,
  flip: original.animations.find(
    (c) => c.id === "35bd4806-9b0b-44ca-a85d-4f95eaa12689",
  )!,
  shake: original.animations.find(
    (c) => c.id === "2126cf19-57f4-4c9a-9e47-dca1145270fb",
  )!,
};
const events: { type: string; description?: string; at: number }[] = [];
let releaseShake: (() => void) | null = null,
  holdShake = true;
http
  .createServer(async (req, res) => {
    try {
      if (req.url === "/qa/state") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ events, held: !!releaseShake }));
        return;
      }
      if (req.url === "/qa/release") {
        holdShake = false;
        releaseShake?.();
        res.end("ok");
        return;
      }
      const bytes = [];
      for await (const b of req) bytes.push(b);
      const input = JSON.parse(Buffer.concat(bytes).toString("utf8"));
      if (req.url === "/api/chat") {
        const context = JSON.parse(input.messages[1].content);
        if (input.messages[1].content.includes('"modelJson"'))
          throw new Error("Full geometry leaked to planner");
        events.push({
          type: "chat",
          description: context.request,
          at: Date.now(),
        });
        const previous = context.previous?.actors[0],
          existing =
            previous &&
            context.catalogue.actors
              .find((a: { id: string }) => a.id === previous.actorId)
              ?.models.find(
                (m: { id: string }) => m.id === previous.modelRevisionId,
              );
        const role: SceneBlueprint["actors"][number] = {
          key: "duck",
          name: "钢铁侠鸭",
          ...(previous ? { instanceId: previous.instanceId } : {}),
          model: existing
            ? {
                source: "existing",
                actorId: previous.actorId,
                modelRevisionId: previous.modelRevisionId,
              }
            : {
                source: "generate",
                description: "一只穿红金色钢铁侠装甲的鸭子",
              },
          animations: (Object.keys(clips) as (keyof typeof clips)[]).map(
            (key) =>
              existing
                ? {
                    key,
                    name: clips[key].name,
                    source: "existing" as const,
                    clipId: existing.animations.find(
                      (c: { name: string }) => c.name === clips[key].name,
                    ).id,
                  }
                : {
                    key,
                    name: clips[key].name,
                    source: "generate" as const,
                    description: key === "run" ? "running cycle" : key,
                    mode:
                      key === "flip" ? ("pro" as const) : ("quick" as const),
                    loop: key === "run",
                  },
          ),
          origin: "circuit",
          locations: [
            {
              key: "circuit",
              featureId: "water:pond",
              relation: "surroundingRoute",
            },
            {
              key: "show",
              featureId: "object:obj-code-94fac7b5-196d-47fd",
              relation: "center",
            },
            { key: "facing", featureId: "water:pond", relation: "facing" },
          ],
          actions: [
            {
              key: "patrol",
              name: "池塘巡游",
              steps: [
                {
                  type: "followRoute",
                  route: "circuit",
                  animation: "run",
                  speed: 3,
                  rate: 1,
                },
              ],
            },
            {
              key: "show",
              name: "桥上表演并返回",
              steps: [
                {
                  type: "moveTo",
                  target: "show",
                  animation: "run",
                  speed: 3,
                  rate: 1,
                },
                { type: "face", target: "facing" },
                {
                  type: "playClip",
                  animation: "flip",
                  rate: 1,
                  repetitions: 3,
                },
                {
                  type: "playClip",
                  animation: "shake",
                  rate: 1,
                  repetitions: 1,
                },
                {
                  type: "moveTo",
                  target: "circuit",
                  animation: "run",
                  speed: 3,
                  rate: 1,
                },
              ],
            },
          ],
          states: [
            {
              key: "patrol",
              name: "池塘巡游",
              action: "patrol",
              repetitions: context.request.includes("三圈") ? 3 : 1,
              waitSeconds: 0,
              next: "show",
            },
            {
              key: "show",
              name: "桥上表演并返回",
              action: "show",
              repetitions: 1,
              waitSeconds: 0,
              next: "patrol",
            },
          ],
          initialState: "patrol",
        };
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            content: JSON.stringify({
              schemaVersion: 1,
              name: "自动庭院·钢铁侠鸭",
              actors: [role],
            }),
          }),
        );
        return;
      }
      if (req.url === "/api/generate/model") {
        events.push({
          type: "model",
          description: input.description,
          at: Date.now(),
        });
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write('data: {"stage":"thinking_start"}\n\n');
        await new Promise((r) => setTimeout(r, 1000));
        res.end(
          `data: ${JSON.stringify({ modelJson: original.modelRevisions.find((m) => m.id === clips.run.modelRevisionId)!.modelJson, stage: "result" })}\n\n`,
        );
        return;
      }
      if (req.url === "/api/generate/animation") {
        if (!input.modelJson?.nodes?.length || input.emitParticles !== false)
          throw new Error("Invalid animation transport");
        events.push({
          type: "animation",
          description: input.description,
          at: Date.now(),
        });
        const key = input.description.includes("cycle")
          ? "run"
          : (input.description as "flip" | "shake");
        if (key === "shake" && holdShake)
          await new Promise<void>((r) => (releaseShake = r));
        else await new Promise((r) => setTimeout(r, 500));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, baked: clips[key].animation }));
        return;
      }
      res.writeHead(404).end();
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
  })
  .listen(5296, "127.0.0.1");
await build({ build: { outDir: path.join(dir, "dist") } });
const store = new Store(path.join(dir, "data"));
createServer(
  store,
  path.join(dir, "dist"),
  new SceneGenerationService(store, { api: "http://127.0.0.1:5296" }),
).listen(5294, "127.0.0.1", () =>
  console.log(`Generation QA http://127.0.0.1:5294/ ; isolated data ${dir}`),
);
