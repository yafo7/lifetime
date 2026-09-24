import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { Store } from "../src/server/store";
import { createServer } from "../src/server/http";
import { decodeMapFile, encodeMapFile } from "../src/server/mapFiles";
import {
  encodeMapTransfer,
  encodeScenePackage,
} from "../src/client/rendering/map/shared/scenePackage";
import { normalizeRenderScheme } from "../src/client/rendering/map/shared/renderScheme";
import { modelJson, revision, clip, testMap } from "./fixtures";
let dir: string, store: Store;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "lifetime-test-"));
  store = new Store(dir);
});
afterEach(async () => {
  if (
    path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) ||
    !path.basename(dir).startsWith("lifetime-test-")
  )
    throw new Error("Unexpected temporary directory");
  await rm(dir, { recursive: true, force: true });
});
describe("independent resource storage", () => {
  it("rejects incomplete documents rather than silently creating an empty map", () => {
    expect(() =>
      decodeMapFile(
        strToU8(
          JSON.stringify({ schemaVersion: 1, kind: "worldforge-map", map: {} }),
        ),
      ),
    ).toThrow("缺少必要数据");
  });
  it("preserves concurrent revisions and clips across store restart", async () => {
    const actor = await store.createActor("Robot");
    await store.appendModel(actor.id, revision);
    await Promise.all([
      store.appendModel(actor.id, { ...revision, id: "model-v2" }),
      store.appendClip(actor.id, clip),
    ]);
    await store.appendClip(actor.id, clip);
    const loaded = await new Store(dir).get<typeof actor>("actors", actor.id);
    expect(loaded.modelRevisions).toHaveLength(2);
    expect(loaded.animations).toHaveLength(1);
    expect(loaded.animations[0].modelRevisionId).toBe(revision.id);
    expect(loaded.modelRevisions[0].modelJson).toEqual(modelJson);
  });
  it("rejects clips with missing model revisions and path traversal", async () => {
    const actor = await store.createActor("Robot");
    await expect(store.appendClip(actor.id, clip)).rejects.toThrow("绑定");
    await expect(store.get("actors", "../escape")).rejects.toThrow("ID");
  });
  it("round trips map packages without an editor confirmation stage", () => {
    const resource = {
      id: "local",
      updatedAt: 1,
      ...decodeMapFile(encodeMapTransfer(testMap)),
    };
    const decoded = decodeMapFile(encodeMapFile(resource));
    expect(decoded.map.objects).toEqual(testMap.objects);
    expect(decoded.map.terrain).toEqual(testMap.terrain);
    expect(decoded.scheme).toBeNull();
  });
  it("preserves render scheme and embedded HDRI in WorldForge scene imports", () => {
    const scheme = normalizeRenderScheme({
      id: "render-test",
      name: "测试渲染",
    });
    const bytes = encodeScenePackage({
      map: testMap,
      renderScheme: scheme,
      hdri: { file: "sky.hdr", bytes: new Uint8Array([1, 2, 3]) },
    });
    const resource = { id: "local", updatedAt: 1, ...decodeMapFile(bytes) };
    const decoded = decodeMapFile(encodeMapFile(resource));
    expect(decoded.scheme?.id).toBe(scheme.id);
    expect(decoded.hdri?.base64).toBe("AQID");
  });
  it("rejects zip traversal and maps missing referenced assets", () => {
    expect(() =>
      decodeMapFile(zipSync({ "../escape": strToU8("bad") })),
    ).toThrow("路径");
    const map = structuredClone(testMap);
    map.objects.push({
      id: "x",
      name: "missing",
      assetId: "no-model",
      parentId: null,
      visible: true,
      locked: false,
      transform: {
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        size: [1, 1, 1],
      },
    });
    expect(() => decodeMapFile(encodeMapTransfer(map))).toThrow("缺少资源");
  });
  it("persists independent instances and enforces revision/clip ownership", async () => {
    const actor = await store.createActor("Robot");
    await store.appendModel(actor.id, revision);
    await store.appendClip(actor.id, clip);
    await store.appendModel(actor.id, { ...revision, id: "model-v2" });
    const map = await store.saveMap({
      name: testMap.name,
      map: testMap,
      scheme: null,
    });
    const instance = {
      id: "instance-a",
      actorId: actor.id,
      modelRevisionId: revision.id,
      clipId: clip.id,
      position: [1, 2, 3] as [number, number, number],
      rotation: 45,
      scale: 1,
      loop: true,
    };
    const draft = {
      id: "performance",
      name: "show",
      mapId: map.id,
      instances: [
        instance,
        {
          ...instance,
          id: "instance-b",
          position: [4, 5, 6] as [number, number, number],
        },
      ],
      updatedAt: 1,
    };
    await store.savePerformance(draft);
    expect((await store.get<typeof map>("maps", map.id)).map.objects).toEqual(
      testMap.objects,
    );
    draft.instances[0].modelRevisionId = "model-v2";
    await expect(store.savePerformance(draft)).rejects.toThrow("不匹配");
  });
  it("serves storage endpoints without exposing generation or old agents", async () => {
    const server = createServer(store);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port,
      base = `http://127.0.0.1:${port}`;
    try {
      const response = await fetch(`${base}/api/resources/actors`, {
        method: "POST",
        body: JSON.stringify({ name: "HTTP actor" }),
      });
      expect(response.status).toBe(201);
      const actor = await response.json();
      expect(
        (await fetch(`${base}/api/resources/actors/${actor.id}`)).status,
      ).toBe(200);
      expect((await fetch(`${base}/api/lifetime/motion-jobs`)).status).toBe(
        404,
      );
      expect(
        (
          await fetch(`${base}/api/resources/actors`, {
            method: "POST",
            headers: { Origin: "https://outside.example" },
            body: "{}",
          })
        ).status,
      ).toBe(403);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });
});
