import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import type { Performance } from "../src/shared/contracts";
import type { SceneAction } from "../src/shared/sceneMotion";
import { createActionTemplate } from "../src/shared/actionTemplates";
import { actionInputs } from "../src/shared/actionBinding";
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
  it("persists actor action references and map bindings without duplicating animation plans in Play", async () => {
    let actor = await store.createActor("Reusable actor");
    actor = await store.appendModel(actor.id, revision);
    actor = await store.appendClip(actor.id, clip);
    const template = createActionTemplate(
      actor,
      revision.id,
      "visit",
      clip.id,
      [clip.id],
    );
    actor = await store.saveMotionAction(actor.id, {
      ...template,
      id: "visit",
      name: template.plan.name,
      prompt: "visit",
      modelRevisionId: revision.id,
      createdAt: 1,
      updatedAt: 1,
    });
    const source = actor.motionActions![0],
      snapshot = structuredClone(actor);
    const map = await store.saveMap({
      name: testMap.name,
      map: testMap,
      scheme: null,
    });
    const draft: Performance = {
      id: "bound-performance",
      name: "show",
      mapId: map.id,
      updatedAt: 1,
      instances: [
        {
          id: "one",
          actorId: actor.id,
          modelRevisionId: revision.id,
          clipId: null,
          position: [0, 0, 0],
          rotation: 0,
          scale: 1,
          loop: false,
          sceneMotion: {
            schemaVersion: 2,
            points: [
              { id: "target", name: "p1", ground: [3, 0, 3], height: 0 },
            ],
            selectedActionId: "visit",
            startPointId: null,
            navigation: { radius: 0.3, height: 3, climb: 0.3, slope: 35 },
            actions: [
              {
                id: "visit",
                name: "Visit",
                actorActionId: source.id,
                actorActionUpdatedAt: source.updatedAt,
                bindings: Object.fromEntries(
                  actionInputs(source).map((slot) => [slot.id, "target"]),
                ),
              },
            ],
            machine: {
              schemaVersion: 1,
              enabled: true,
              initialStateId: "visit",
              states: [
                {
                  id: "visit",
                  name: "Visit",
                  actionId: "visit",
                  repetitions: 1,
                  waitSeconds: 0,
                  nextStateId: "visit",
                },
              ],
            },
          },
        },
      ],
    };
    const saved = await store.savePerformance(draft),
      loaded = await new Store(dir).get<Performance>("performances", draft.id);
    expect(loaded).toEqual(saved);
    expect(loaded.instances[0].sceneMotion!.actions[0]).not.toHaveProperty(
      "plan",
    );
    expect(await store.get("actors", actor.id)).toEqual(snapshot);
    const invalid = structuredClone(saved);
    const bound = invalid.instances[0].sceneMotion!.actions[0];
    if ("actorActionId" in bound) bound.actorActionId = "missing";
    await expect(store.savePerformance(invalid)).rejects.toThrow(
      "演员动作不存在",
    );
    expect(await store.get("performances", saved.id)).toEqual(saved);
  });
  it("round trips scene points and instance actions, rejects broken edits atomically", async () => {
    let actor = await store.createActor("Scene actor");
    actor = await store.appendModel(actor.id, revision);
    actor = await store.appendClip(actor.id, clip);
    const source = structuredClone(actor);
    const map = await store.saveMap({
      name: testMap.name,
      map: testMap,
      scheme: null,
    });
    const draft: Performance = {
      id: "scene-performance",
      name: "Scene",
      mapId: map.id,
      updatedAt: 1,
      instances: [
        {
          id: "one",
          actorId: actor.id,
          modelRevisionId: revision.id,
          clipId: null,
          position: [0, 0, 0],
          rotation: 0,
          scale: 1,
          loop: false,
          sceneMotion: {
            schemaVersion: 1,
            points: [
              { id: "p1", name: "p1", ground: [3, 0, 0], height: 0 },
              { id: "p2", name: "p2", ground: null, height: 0 },
            ],
            navigation: { radius: 0.3, height: 3, climb: 0.3, slope: 35 },
            startPointId: null,
            selectedActionId: "action",
            actions: [
              {
                id: "action",
                name: "move and pose",
                plan: {
                  schemaVersion: 2,
                  name: "move and pose",
                  modelRevisionId: revision.id,
                  steps: [
                    {
                      id: "move",
                      type: "moveTo",
                      destination: { point: "p1" },
                      speed: 2,
                      path: { mode: "ground" },
                      animation: { clipId: clip.id, repeat: "untilArrival" },
                    },
                    {
                      id: "pose",
                      type: "playClip",
                      animation: { clipId: clip.id, rate: 2, repeat: 1 },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    };
    draft.instances[0].sceneMotion!.machine = {
      schemaVersion: 1,
      enabled: true,
      initialStateId: "patrol",
      states: [
        {
          id: "patrol",
          name: "巡游",
          actionId: "action",
          repetitions: 2,
          waitSeconds: 1,
          nextStateId: "patrol",
        },
      ],
    };
    const saved = await store.savePerformance(draft),
      loaded = await new Store(dir).get<Performance>("performances", draft.id);
    expect(loaded).toEqual(saved);
    expect(await store.get("actors", actor.id)).toEqual(source);
    const brokenState = structuredClone(saved);
    brokenState.instances[0].sceneMotion!.machine!.states[0].nextStateId =
      "missing";
    await expect(store.savePerformance(brokenState)).rejects.toThrow(
      "后续状态",
    );
    brokenState.instances[0].sceneMotion!.machine!.states[0].nextStateId = null;
    brokenState.instances[0].sceneMotion!.actions = [];
    brokenState.instances[0].sceneMotion!.selectedActionId = null;
    await expect(store.savePerformance(brokenState)).rejects.toThrow(
      "角色状态",
    );
    const invalid = structuredClone(saved);
    invalid.instances[0].sceneMotion!.points[0].ground = [30, 0, 0];
    await expect(store.savePerformance(invalid)).rejects.toThrow();
    invalid.instances[0].sceneMotion!.points[0].ground = [3, 0, 0];
    (
      invalid.instances[0].sceneMotion!.actions[0] as SceneAction
    ).plan.steps[1] = {
      id: "pose",
      type: "playClip",
      animation: { clipId: "missing" },
    };
    await expect(store.savePerformance(invalid)).rejects.toThrow();
    expect(await store.get<Performance>("performances", draft.id)).toEqual(
      saved,
    );
  });
  it("reads legacy pools without loss and round trips new actions separately", async () => {
    let actor = await store.createActor("Legacy");
    await store.appendModel(actor.id, revision);
    actor = await store.appendClip(actor.id, clip);
    const pool = {
      id: "old-pool",
      name: "Legacy pool",
      createdAt: 123,
      modelRevisionId: revision.id,
      clipIds: [clip.id],
    };
    delete actor.pools;
    delete actor.motionActions;
    actor.actions = [pool];
    await writeFile(
      path.join(dir, "actors", actor.id + ".json"),
      JSON.stringify(actor),
    );
    actor = await store.get<typeof actor>("actors", actor.id);
    expect(actor.pools).toEqual([pool]);
    expect(actor.motionActions).toEqual([]);
    const plan = {
      schemaVersion: 1 as const,
      name: "Go",
      modelRevisionId: revision.id,
      poolId: pool.id,
      steps: [
        { id: "play", type: "playClip" as const, animation: { slot: "clip1" } },
      ],
    };
    actor = await store.saveMotionAction(actor.id, {
      id: "new-action",
      name: "Go",
      modelRevisionId: revision.id,
      createdAt: 0,
      updatedAt: 0,
      prompt: "wave",
      plan,
    });
    const loaded = await new Store(dir).get<typeof actor>("actors", actor.id);
    expect(loaded.pools).toEqual([pool]);
    expect(loaded.actions).toEqual([pool]);
    expect(loaded.motionActions?.[0].plan).toEqual(plan);
    await expect(
      store.saveAction(actor.id, {
        ...pool,
        entries: [
          {
            slot: "renamed",
            clipId: clip.id,
            segments: [{ name: "full", start: 0, end: 2, loop: true }],
          },
        ],
      }),
    ).rejects.toThrow("动画不存在");
    const after = await store.get<typeof actor>("actors", actor.id);
    expect(after.pools).toEqual([pool]);
  });

  it("persists action pools and rejects cross-version or duplicate clips", async () => {
    const actor = await store.createActor("Pool actor");
    await store.appendModel(actor.id, revision);
    await store.appendModel(actor.id, { ...revision, id: "other-model" });
    await store.appendClip(actor.id, clip);
    const action = {
      id: "action-test",
      name: "Walk and flip",
      createdAt: 0,
      modelRevisionId: revision.id,
      clipIds: [clip.id],
    };
    await store.saveAction(actor.id, action);
    await store.renameActor(actor.id, "Renamed");
    const updated = await store.saveAction(actor.id, {
      ...action,
      name: "Updated",
    });
    expect(updated.actions).toHaveLength(1);
    const loaded = await new Store(dir).get<typeof actor>("actors", actor.id);
    expect(loaded.actions?.[0].name).toBe("Updated");
    expect(loaded.actions?.[0].clipIds).toEqual([clip.id]);
    await expect(
      store.saveAction(actor.id, { ...action, clipIds: [] }),
    ).rejects.toThrow("动作池");
    await expect(
      store.saveAction(actor.id, { ...action, clipIds: [clip.id, clip.id] }),
    ).rejects.toThrow("动作池");
    await expect(
      store.saveAction(actor.id, {
        ...action,
        id: "other",
        modelRevisionId: "other-model",
      }),
    ).rejects.toThrow("动作池");
    await expect(
      store.saveAction(actor.id, { ...action, clipIds: ["missing"] }),
    ).rejects.toThrow("动作池");
  });

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
