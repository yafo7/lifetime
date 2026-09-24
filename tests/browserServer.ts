/** Local QA only: fixed backend responses and temporary storage. Never touches app data. */
import http from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/server/store";
import { createServer } from "../src/server/http";
import { modelJson, baked, testMap } from "./fixtures";
import { encodeMapTransfer } from "../src/client/rendering/map/shared/scenePackage";
const dir = await mkdtemp(path.join(os.tmpdir(), "lifetime-browser-"));
const store = new Store(dir);
await store.createActor("验证演员（固定样本）");
await store.saveMap({ name: testMap.name, map: testMap, scheme: null });
await mkdir("test-results", { recursive: true });
await writeFile(
  "test-results/sample-map.worldforge-map.json",
  encodeMapTransfer(testMap),
);
createServer(store).listen(5291, "127.0.0.1");
http
  .createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:5290");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    console.log(req.url, body.description);
    if (req.url === "/api/generate/model") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('event: thinking_start\ndata: {"stage":"thinking_start"}\n\n');
      setTimeout(
        () =>
          res.end(
            `event: result\ndata: ${JSON.stringify({ stage: "result", modelJson })}\n\n`,
          ),
        2500,
      );
    } else if (req.url === "/api/generate/animation") {
      res.writeHead(200, { "Content-Type": "application/json" });
      setTimeout(() => res.end(JSON.stringify({ ok: true, baked })), 1000);
    } else res.writeHead(404).end();
  })
  .listen(5292, "127.0.0.1", () =>
    console.log(`QA fixture backend 5292; storage 5291; temporary data ${dir}`),
  );
