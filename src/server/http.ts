import type { SavedAction } from "../shared/motion";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Store, type Collection } from "./store";
import { decodeMapFile, encodeMapFile } from "./mapFiles";
import type { MapResource } from "../shared/maps";
import type {
  AnimationClip,
  ActionPool,
  ModelRevision,
  Performance,
} from "../shared/contracts";

export function createServer(store: Store, publicRoot?: string): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith("/api/resources")) {
        if (!publicRoot || req.method !== "GET") {
          res.writeHead(404).end();
          return;
        }
        const relative =
          decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
        const file = path.resolve(publicRoot, relative);
        if (!file.startsWith(path.resolve(publicRoot) + path.sep))
          throw new Error("无效资源路径");
        const types: Record<string, string> = {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript",
          ".css": "text/css",
          ".png": "image/png",
          ".json": "application/json",
        };
        res.setHeader(
          "Content-Type",
          types[path.extname(file)] ?? "application/octet-stream",
        );
        res.end(await readFile(file));
        return;
      }
      const origin = req.headers.origin;
      if (
        origin &&
        !["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)
      ) {
        res.writeHead(403).end();
        return;
      }
      const [, , , collection, id, action] = url.pathname.split("/");
      if (!["actors", "maps", "performances"].includes(collection)) {
        res.writeHead(404).end();
        return;
      }
      const kind = collection as Collection;
      const json = (value: unknown, status = 200) => {
        res.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(value));
      };
      if (req.method === "GET") {
        if (kind === "maps" && id && action === "export") {
          const bytes = encodeMapFile(await store.get<MapResource>("maps", id));
          res.writeHead(200, {
            "Content-Type": "application/zip",
            "Content-Disposition": 'attachment; filename="lifetime-scene.zip"',
          });
          res.end(bytes);
          return;
        }
        if (kind === "maps" && id && action === "hdri") {
          const map = await store.get<MapResource>("maps", id);
          if (!map.hdri) throw new Error("环境贴图不存在");
          res.setHeader("Content-Type", "application/octet-stream");
          res.end(Buffer.from(map.hdri.base64, "base64"));
          return;
        }
        json(id ? await store.get(kind, id) : await store.list(kind));
        return;
      }
      const raw = await readBody(req);
      if (kind === "maps" && req.method === "POST" && !id) {
        const existing = url.searchParams.get("mapId");
        json(
          await store.saveMap(
            decodeMapFile(
              raw,
              existing
                ? await store.get<MapResource>("maps", existing)
                : undefined,
            ),
          ),
          201,
        );
        return;
      }
      const body = JSON.parse(raw.toString("utf8"));
      if (kind === "actors" && req.method === "POST" && !id) {
        json(await store.createActor(body.name), 201);
        return;
      }
      if (kind === "actors" && id && req.method === "PATCH" && !action) {
        json(await store.renameActor(id, body.name));
        return;
      }
      if (
        kind === "actors" &&
        id &&
        req.method === "POST" &&
        action === "models"
      ) {
        json(await store.appendModel(id, body as ModelRevision), 201);
        return;
      }
      if (
        kind === "actors" &&
        id &&
        req.method === "POST" &&
        action === "clips"
      ) {
        json(await store.appendClip(id, body as AnimationClip), 201);
        return;
      }
      if (
        kind === "actors" &&
        id &&
        req.method === "POST" &&
        (action === "actions" || action === "pools")
      ) {
        json(await store.saveAction(id, body as ActionPool), 201);
        return;
      }
      if (
        kind === "actors" &&
        id &&
        req.method === "POST" &&
        action === "motion-actions"
      ) {
        json(await store.saveMotionAction(id, body as SavedAction), 201);
        return;
      }
      if (kind === "performances" && req.method === "PUT" && id === body.id) {
        json(await store.savePerformance(body as Performance));
        return;
      }
      res.writeHead(404).end();
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "操作失败",
          code: (error as { code?: string })?.code,
        }),
      );
    }
  });
}
async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024 * 1024) throw new Error("文件超过 128 MB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
