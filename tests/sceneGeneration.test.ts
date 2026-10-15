import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Store } from "../src/server/store";
import { SceneGenerationService } from "../src/server/builds/service";
import { GenerationFailure } from "../src/generation/client";
import { planBlueprint, blueprintProtocol } from "../src/server/builds/planner";
import { scenePlan, sceneMap, sceneActor } from "./sceneFixtures";
import { modelJson, baked } from "./fixtures";
import {
  validateBlueprint,
  type SceneBlueprint,
} from "../src/shared/sceneBlueprint";
import { sceneCatalogue } from "../src/shared/scenePlan";
import { buildSemanticIndex } from "../src/client/navigation/semanticIndex";
import type { AssemblyDraft } from "../src/shared/sceneBuild";
import type { Actor, Performance } from "../src/shared/contracts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function blueprint(): SceneBlueprint {
  const {
    actorId: _actor,
    modelRevisionId: _model,
    ...role
  } = scenePlan().actors[0];
  for (const action of role.actions)
    for (const step of action.steps)
      if ("animation" in step) step.animation = "run";
  role.actions[1].steps.splice(
    2,
    1,
    { type: "playClip", animation: "flip", rate: 1, repetitions: 3 },
    { type: "playClip", animation: "shake", rate: 1, repetitions: 1 },
  );
  return {
    schemaVersion: 1,
    name: "generated court",
    actors: [
      {
        ...role,
        model: { source: "generate", description: "穿红金色装甲的鸭子" },
        animations: [
          {
            key: "run",
            name: "奔跑",
            source: "generate",
            description: "running cycle",
            mode: "quick",
            loop: true,
          },
          {
            key: "flip",
            name: "后空翻",
            source: "generate",
            description: "backflip",
            mode: "pro",
            loop: false,
          },
          {
            key: "shake",
            name: "摇头",
            source: "generate",
            description: "shake",
            mode: "quick",
            loop: false,
          },
        ],
      },
    ],
  };
}
async function setup(
  options: ConstructorParameters<typeof SceneGenerationService>[1] = {},
  plan = blueprint(),
) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "lifetime-generation-test-"),
  );
  const store = new Store(root),
    map = await store.saveMap({
      name: sceneMap.name,
      map: sceneMap.map,
      scheme: null,
    });
  const base: Performance = {
    id: "base",
    name: "base",
    mapId: map.id,
    instances: [],
    updatedAt: 1,
  };
  const planner = vi.fn(async () => plan),
    model = vi.fn(async () => ({ modelJson })),
    animation = vi.fn(async (_model: unknown, description: string) => ({
      baked: { ...structuredClone(baked), loop: description.includes("cycle") },
    }));
  const service = new SceneGenerationService(store, {
    planner,
    model,
    animation,
    ...options,
  });
  cleanups.push(async () => {
    await service.close();
    if (
      path.dirname(root) !== path.resolve(os.tmpdir()) ||
      !path.basename(root).startsWith("lifetime-generation-test-")
    )
      throw new Error("Unexpected fixture directory");
    await rm(root, { recursive: true, force: true });
  });
  const create = () =>
    service.create({ id: "run", request: "duck performs", base, climb: 0.4 });
  const until = async (phase: string) => {
    await vi.waitFor(
      async () => {
        const run = await service.get("run");
        expect(
          run.phase,
          JSON.stringify({
            status: run.status,
            tasks: run.tasks.map((t) => ({
              name: t.name,
              state: t.state,
              status: t.status,
            })),
          }),
        ).toBe(phase);
      },
      { timeout: 3000 },
    );
    return service.get("run");
  };
  return {
    root,
    service,
    store,
    map,
    base,
    create,
    until,
    planner,
    model,
    animation,
  };
}

describe("durable automatic scene generation", () => {
  it("queues navigation clips without chat/model generation, deduplicates requests and stores clips on the exact model", async () => {
    const s = await setup();
    await s.store.createActor(sceneActor.name, sceneActor.id);
    await s.store.appendModel(sceneActor.id, sceneActor.modelRevisions[0]);
    const base = {
      ...s.base,
      instances: [
        {
          id: "npc",
          actorId: sceneActor.id,
          modelRevisionId: sceneActor.modelRevisions[0].id,
          clipId: null,
          position: [0, 0, 0] as [number, number, number],
          rotation: 0,
          scale: 1,
          loop: false,
        },
      ],
    };
    const input = { base, instanceId: "npc", kinds: ["jump" as const] };
    const [first, same] = await Promise.all([
      s.service.createTraversal(input),
      s.service.createTraversal(input),
    ]);
    expect(first.id).toBe(same.id);
    await vi.waitFor(async () =>
      expect((await s.service.get(first.id)).phase).toBe("ready"),
    );
    expect(s.animation).toHaveBeenCalledTimes(1);
    expect(s.planner).not.toHaveBeenCalled();
    expect(s.model).not.toHaveBeenCalled();
    const actor = await s.store.get<Actor>("actors", sceneActor.id);
    expect(actor.animations).toHaveLength(1);
    expect(actor.animations[0]).toMatchObject({
      modelRevisionId: sceneActor.modelRevisions[0].id,
      metadata: { lifetimeTraversal: "jump" },
    });
    expect((await s.service.createTraversal(input)).id).toBe(first.id);
    expect(s.animation).toHaveBeenCalledTimes(1);
    expect(await s.service.list(s.map.id)).toEqual([]);
    expect(await s.service.list(s.map.id, "navigation-assets")).toHaveLength(1);
    await expect(
      s.service.createTraversal({ ...input, kinds: ["fly"] }),
    ).rejects.toThrow("飞行能力");
  });
  it("retains navigation animation results on save failure and only retries saving", async () => {
    const s = await setup();
    await s.store.createActor(sceneActor.name, sceneActor.id);
    await s.store.appendModel(sceneActor.id, sceneActor.modelRevisions[0]);
    const base = {
      ...s.base,
      instances: [
        {
          id: "npc",
          actorId: sceneActor.id,
          modelRevisionId: sceneActor.modelRevisions[0].id,
          clipId: null,
          position: [0, 0, 0] as [number, number, number],
          rotation: 0,
          scale: 1,
          loop: false,
        },
      ],
    };
    vi.spyOn(s.store, "appendClip").mockRejectedValueOnce(
      new Error("disk failed"),
    );
    const run = await s.service.createTraversal({
      base,
      instanceId: "npc",
      kinds: ["jump"],
    });
    await vi.waitFor(async () =>
      expect((await s.service.get(run.id)).phase).toBe("failed"),
    );
    const task = (await s.service.get(run.id)).tasks.find(
      (t) => t.kind === "animation",
    )!;
    expect(task.state).toBe("save-failed");
    await s.service.retry(run.id, task.id);
    await vi.waitFor(async () =>
      expect((await s.service.get(run.id)).phase).toBe("ready"),
    );
    expect(s.animation).toHaveBeenCalledTimes(1);
  });
  it("plans missing assets from compact metadata without the legacy existing-only restriction", async () => {
    const catalogue = sceneCatalogue(
      buildSemanticIndex(sceneMap).summary,
      [sceneActor],
      [],
    );
    const fetcher = vi.fn(
      async (_url: unknown, init: RequestInit | undefined) => {
        const input = JSON.parse(init!.body as string);
        expect(input.messages[1].content).not.toMatch(
          /"(?:modelJson|nodes|terrain|position)"\s*:/,
        );
        return Response.json({ content: JSON.stringify(blueprint()) });
      },
    );
    const plan = await planBlueprint(
      "穿装甲的鸭子",
      catalogue,
      null,
      "http://test-backend",
      new AbortController().signal,
      fetcher as typeof fetch,
    );
    expect(plan.actors[0].model.source).toBe("generate");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(blueprintProtocol).not.toContain("本版本不调用模型或动画生成");
  });
  it("preserves a loopable single-shot response and performs exactly three finite flips", async () => {
    const f = await setup({
      animation: async () => ({ baked: { ...baked, loop: true } }),
    });
    await f.create();
    const run = await f.until("assets-ready");
    const flips = run.plan!.actors[0].actions[1].steps.filter(
      (s) => s.type === "playClip",
    );
    expect(flips).toHaveLength(4);
    expect(
      flips.every((s) => s.type === "playClip" && s.repetitions === 1),
    ).toBe(true);
    const actor = await f.store.get<Actor>("actors", run.manifest.duck.actorId);
    expect(
      actor.animations.every((c) => (c.animation as { loop: boolean }).loop),
    ).toBe(true);
  });
  it("validates map and logical assets before generation, and expands three single flips", async () => {
    const f = await setup();
    const catalogue = sceneCatalogue(
      buildSemanticIndex(f.map).summary,
      [sceneActor],
      [],
    );
    expect(
      validateBlueprint(blueprint(), catalogue).actors[0].model.source,
    ).toBe("generate");
    const invalid = blueprint();
    invalid.actors[0].locations[0].featureId = "water:missing";
    expect(() => validateBlueprint(invalid, catalogue)).toThrow("未知地点");
    const invalidClip = blueprint();
    invalidClip.actors[0].animations[0] = {
      key: "run",
      name: "run",
      source: "existing",
      clipId: sceneActor.animations[0].id,
    };
    expect(() => validateBlueprint(invalidClip, catalogue)).toThrow(
      "指定模型版本",
    );
    await f.create();
    const run = await f.until("assets-ready");
    expect(
      run.plan!.actors[0].actions[1].steps.filter((s) => s.type === "playClip"),
    ).toHaveLength(4);
    expect(f.model).toHaveBeenCalledOnce();
    expect(f.animation).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(run)).not.toContain('"modelJson"');
  });
  it("deduplicates simultaneous submissions of the same build ID", async () => {
    const f = await setup();
    await Promise.all([f.create(), f.create()]);
    await f.until("assets-ready");
    expect(f.planner).toHaveBeenCalledOnce();
    expect(f.model).toHaveBeenCalledOnce();
  });
  it("starts two models concurrently, then parallel animations only after each model is saved", async () => {
    const plan = blueprint();
    plan.actors.push({
      ...structuredClone(plan.actors[0]),
      key: "duck2",
      name: "duck2",
    });
    const releases: (() => void)[] = [];
    const model = vi.fn(async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return { modelJson };
    });
    let active = 0,
      maximum = 0;
    const animation = vi.fn(async (_m: unknown, prompt: string) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return {
        baked: { ...structuredClone(baked), loop: prompt.includes("cycle") },
      };
    });
    const f = await setup({ model, animation }, plan);
    await f.create();
    await vi.waitFor(() => expect(releases).toHaveLength(2), { timeout: 1500 });
    expect(animation).not.toHaveBeenCalled();
    releases.forEach((r) => r());
    const run = await f.until("assets-ready");
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(3);
    const resources = await Promise.all(
      Object.values(run.manifest).map((a) =>
        f.store.get<Actor>("actors", a.actorId),
      ),
    );
    expect(resources).toHaveLength(2);
    resources.forEach((a) =>
      expect(
        a.animations.every((c) => c.modelRevisionId === a.modelRevisions[0].id),
      ).toBe(true),
    );
  });
  it("retries only a failed animation and preserves completed model and clips", async () => {
    let fail = true;
    const animation = vi.fn(async (_m: unknown, prompt: string) => {
      if (prompt === "backflip" && fail) {
        fail = false;
        throw new GenerationFailure("animation rejected");
      }
      return {
        baked: { ...structuredClone(baked), loop: prompt.includes("cycle") },
      };
    });
    const f = await setup({ animation });
    await f.create();
    let run = await f.until("failed");
    const task = run.tasks.find((t) => t.state === "failed")!;
    expect(run.tasks.filter((t) => t.state === "done")).toHaveLength(3);
    await f.service.retry(run.id, task.id);
    run = await f.until("assets-ready");
    expect(animation).toHaveBeenCalledTimes(4);
    expect(f.model).toHaveBeenCalledOnce();
    expect(run.tasks.every((t) => t.state === "done")).toBe(true);
  });
  it("recovers a received result after storage failure without another backend generation", async () => {
    const f = await setup();
    const append = vi
      .spyOn(f.store, "appendModel")
      .mockRejectedValueOnce(new Error("disk unavailable"));
    await f.create();
    const run = await f.until("failed"),
      task = run.tasks.find((t) => t.kind === "model")!;
    expect(task.state).toBe("save-failed");
    await f.service.close();
    const resumed = new SceneGenerationService(f.store, {
      model: f.model,
      animation: f.animation,
    });
    try {
      expect((await resumed.get(run.id)).tasks[0].state).toBe("save-failed");
      await resumed.retry(run.id, task.id);
      await vi.waitFor(async () =>
        expect((await resumed.get(run.id)).phase).toBe("assets-ready"),
      );
      expect(f.model).toHaveBeenCalledOnce();
      expect(append).toHaveBeenCalledTimes(2);
    } finally {
      await resumed.close();
    }
  });
  it("marks unknown responses uncertain and never resubmits them on a whole-build continue", async () => {
    let fail = true;
    const model = vi.fn(async () => {
      if (fail) throw new GenerationFailure("socket closed", true);
      return { modelJson };
    });
    const f = await setup({ model });
    await f.create();
    const run = await f.until("failed");
    expect(run.tasks[0].state).toBe("uncertain");
    await f.service.retry(run.id);
    await f.until("failed");
    expect(model).toHaveBeenCalledOnce();
    fail = false;
    await f.service.retry(run.id, run.tasks[0].id);
    await f.until("assets-ready");
    expect(model).toHaveBeenCalledTimes(2);
  });
  it("recovers an interrupted journal without silently resubmitting an in-flight request", async () => {
    const f = await setup({
      model: async () => {
        throw new GenerationFailure("disconnected", true);
      },
    });
    await f.create();
    const interrupted = await f.until("failed");
    await f.service.close();
    interrupted.phase = "generating";
    interrupted.tasks[0].state = "generating";
    await f.service.journal.write(interrupted);
    const model = vi.fn(async () => ({ modelJson }));
    const resumed = new SceneGenerationService(f.store, {
      model,
      animation: f.animation,
    });
    try {
      const recovered = await resumed.get(interrupted.id);
      expect(recovered.tasks[0].state).toBe("uncertain");
      expect(recovered.tasks[0].status).toContain("服务已重启");
      await resumed.retry(interrupted.id);
      expect(model).not.toHaveBeenCalled();
      await resumed.retry(interrupted.id, interrupted.tasks[0].id);
      await vi.waitFor(async () =>
        expect((await resumed.get(interrupted.id)).phase).toBe("assets-ready"),
      );
      expect(model).toHaveBeenCalledOnce();
    } finally {
      await resumed.close();
    }
  });
  it("reuses saved model and clips without any planning or generation request", async () => {
    const f = await setup();
    await f.create();
    const initial = await f.until("assets-ready");
    const plan = blueprint(),
      assets = initial.manifest.duck;
    plan.actors[0].model = {
      source: "existing",
      actorId: assets.actorId,
      modelRevisionId: assets.modelRevisionId,
    };
    plan.actors[0].animations = plan.actors[0].animations.map((animation) => ({
      key: animation.key,
      name: animation.name,
      source: "existing",
      clipId: assets.animations[animation.key],
    }));
    await f.service.create({
      id: "reused",
      request: "same assets",
      base: f.base,
      climb: 0.4,
      blueprint: plan,
    });
    await vi.waitFor(async () =>
      expect((await f.service.get("reused")).phase).toBe("assets-ready"),
    );
    expect(
      (await f.service.get("reused")).tasks.every(
        (task) => task.reused && task.attempts === 0,
      ),
    ).toBe(true);
    expect(f.planner).toHaveBeenCalledOnce();
    expect(f.model).toHaveBeenCalledOnce();
    expect(f.animation).toHaveBeenCalledTimes(3);
  });
  it("cancels queued work but receives and saves a submitted model, then continues its dependencies", async () => {
    const plan = blueprint();
    plan.actors.push({ ...structuredClone(plan.actors[0]), key: "duck2" });
    let release!: () => void;
    const model = vi.fn(async () => {
      if (model.mock.calls.length === 1)
        await new Promise<void>((r) => (release = r));
      return { modelJson };
    });
    const f = await setup({ model, models: 1 }, plan);
    await f.create();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await f.service.cancel("run");
    release();
    await vi.waitFor(async () =>
      expect((await f.service.get("run")).tasks[0].state).toBe("done"),
    );
    expect((await f.service.get("run")).phase).toBe("cancelled");
    expect(model).toHaveBeenCalledOnce();
    expect(f.animation).not.toHaveBeenCalled();
    await f.service.retry("run");
    await f.until("assets-ready");
    expect(model).toHaveBeenCalledTimes(2);
  });
  it("persists assembly checkpoints across restart and rejects stale revisions, invalid references and publication", async () => {
    const f = await setup();
    await f.create();
    const run = await f.until("assets-ready");
    const claimed = await f.service.claim(run.id, "editor");
    const token = claimed.lease!.token;
    const draft: AssemblyDraft = {
      schemaVersion: 1,
      revision: 0,
      mapRevision: run.mapRevision,
      planSignature: JSON.stringify(run.plan),
      performanceId: "new-performance",
      roles: {},
      state: "working",
    };
    const saved = await f.service.checkpoint(run.id, token, 0, draft);
    expect(saved.assembly!.revision).toBe(1);
    await expect(f.service.checkpoint(run.id, token, 0, draft)).rejects.toThrow(
      "另一个页面修改",
    );
    await expect(
      f.service.checkpoint(run.id, "wrong-token", 1, { ...draft, revision: 1 }),
    ).rejects.toThrow("装配会话");
    await expect(
      f.service.complete(run.id, token, {
        ...f.base,
        id: draft.performanceId,
        sceneDesign: {
          schemaVersion: 1,
          request: run.request,
          plan: run.plan!,
          roles: [],
        },
      }),
    ).rejects.toThrow("完整检查");
    const invalid = {
      ...draft,
      revision: 1,
      roles: {
        unknown: {
          instanceId: "bad",
          locations: {},
          actions: {},
          checks: {},
          issues: [],
        },
      },
    };
    await expect(
      f.service.checkpoint(run.id, token, 1, invalid),
    ).rejects.toThrow("角色无效");
    const write = vi
      .spyOn(f.service.journal, "write")
      .mockRejectedValueOnce(new Error("disk full"));
    await expect(
      f.service.checkpoint(run.id, token, 1, { ...draft, revision: 1 }),
    ).rejects.toThrow("disk full");
    expect((await f.service.get(run.id)).assembly!.revision).toBe(1);
    write.mockRestore();
    await f.service.close();
    const resumed = new SceneGenerationService(f.store, {
      model: f.model,
      animation: f.animation,
    });
    try {
      const recovered = await resumed.get(run.id);
      expect(recovered.phase).toBe("assets-ready");
      expect(recovered.assembly).toEqual(saved.assembly);
      expect(f.model).toHaveBeenCalledOnce();
      expect(f.animation).toHaveBeenCalledTimes(3);
    } finally {
      await resumed.close();
    }
  });
  it("retains a malformed planner response before validation without resubmitting it", async () => {
    const f = await setup({
      planner: planBlueprint,
      fetcher: async () =>
        new Response(JSON.stringify({ content: "invalid plan response" })),
    });
    await f.create();
    const run = await f.until("failed");
    expect(run.planningResponse).toBe("invalid plan response");
    expect(run.error).toContain("合法JSON");
    expect(f.model).not.toHaveBeenCalled();
  });
  it("does not falsify looping animation metadata and rejects concurrent assembly owners", async () => {
    const f = await setup({
      animation: async () => ({ baked: { ...baked, loop: false } }),
    });
    await f.create();
    const run = await f.until("failed");
    expect(run.tasks.find((t) => t.animationKey === "run")?.state).toBe(
      "failed",
    );
    expect(run.tasks.find((t) => t.animationKey === "run")?.status).toContain(
      "循环属性",
    );
    const g = await setup();
    await g.create();
    await g.until("assets-ready");
    const lease = await g.service.claim("run", "first", 1.1);
    expect(lease.climb).toBe(1.1);
    await expect(g.service.claim("run", "second")).rejects.toThrow(
      "另一个页面",
    );
    await g.service.release("run", lease.lease!.token, "navigation blocked");
    expect((await g.service.get("run")).phase).toBe("assets-ready");
  });
});
