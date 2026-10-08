import { describe, expect, it } from "vitest";
import {
  capabilities,
  validateAction,
  validateDocument,
  validateAnimationReferences,
  validatePoints,
  pointPosition,
  type ActionPoint,
  type MotionPlan,
  type MotionContext,
  type PromptPart,
} from "../src/shared/motion";
import { MotionRuntime } from "../src/client/motion/runtime";
import { planMotion } from "../src/client/services/motionPlanner";
import { clip, revision } from "./fixtures";
import { Store } from "../src/server/store";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const points = (): ActionPoint[] => [
  { id: "start", name: "p1", ground: [0, 0, 0], height: 0 },
  { id: "end", name: "p2", ground: [4, 0, 0], height: 0 },
];
const context = (): MotionContext => ({
  actor: {
    id: "actor",
    name: "Robot",
    updatedAt: 1,
    modelRevisions: [revision],
    animations: [clip],
  },
  modelRevisionId: revision.id,
  points: points(),
});
const plan = (): MotionPlan => ({
  schemaVersion: 2,
  name: "走到标点",
  modelRevisionId: revision.id,
  start: { point: "start" },
  steps: [
    {
      id: "walk",
      type: "moveTo",
      destination: { point: "end" },
      speed: 2,
      animation: { clipId: clip.id, repeat: "untilArrival" },
    },
  ],
});
const doc: PromptPart[] = [
  { type: "text", text: "以 " },
  { type: "point", pointId: "start" },
  { type: "text", text: " 为起点，走到 " },
  { type: "point", pointId: "end" },
];

describe("library-based actions and point references", () => {
  it("binds animation tokens to exact resources and rejects ignored or cross-version tokens", async () => {
    const ctx = context();
    const tokens: PromptPart[] = [
      ...doc,
      { type: "animation", clipId: clip.id, modelRevisionId: revision.id },
    ];
    validateDocument(tokens, ctx.points!, ctx);
    validateAnimationReferences(tokens, plan(), ctx);
    expect(() =>
      validateDocument(
        [
          ...doc,
          { type: "animation", clipId: clip.id, modelRevisionId: "other" },
        ],
        ctx.points!,
        ctx,
      ),
    ).toThrow("版本");
    const sameName = { ...clip, id: "same-name" };
    ctx.actor.animations.push(sameName);
    const wrong = plan();
    if (wrong.steps[0].type === "moveTo")
      wrong.steps[0].animation!.clipId = sameName.id;
    await expect(
      planMotion("使用指定动画", ctx, {
        document: tokens,
        fetcher: async () =>
          new Response(JSON.stringify({ content: JSON.stringify(wrong) })),
      }),
    ).rejects.toThrow("未使用指定动画");
  });
  it("uses all revision animations without a pool and rejects cross-revision references", () => {
    const ctx = context();
    ctx.actor.animations.push({
      ...clip,
      id: "other",
      modelRevisionId: "other-model",
    });
    const caps = capabilities(ctx);
    expect(caps.schemaVersion).toBe(2);
    expect(caps).not.toHaveProperty("poolId");
    expect(caps.animations.map((c) => c.clipId)).toEqual([clip.id]);
    expect(validateAction(plan(), ctx)).toEqual(plan());
    const wrong = plan();
    if (wrong.steps[0].type === "moveTo")
      wrong.steps[0].animation!.clipId = "other";
    expect(() => validateAction(wrong, ctx)).toThrow("动画不存在");
    const mixed = plan();
    mixed.poolId = "legacy";
    expect(() => validateAction(mixed, ctx)).toThrow("版本不匹配");
  });
  it("resolves explicit starts, snapshots current point coordinates and re-resolves on next execution", () => {
    const ctx = context(),
      runtime = new MotionRuntime(),
      p = plan();
    runtime.executeAction(p, ctx, "robot", {}, [30, 0, 30]);
    expect(runtime.getExecutionState()?.position).toEqual([0, 0, 0]);
    ctx.points![1].ground = [8, 0, 0];
    runtime.advance(2);
    expect(runtime.getExecutionState()?.position).toEqual([4, 0, 0]);
    runtime.executeAction(p, ctx, "robot");
    runtime.advance(4);
    expect(runtime.getExecutionState()?.position).toEqual([8, 0, 0]);
    expect(p.steps[0]).toMatchObject({ destination: { point: "end" } });
  });
  it("supports air points and point waypoints, rejecting elevated ground routes before moving", () => {
    const ctx = context(),
      runtime = new MotionRuntime(),
      p = plan();
    ctx.points![1].height = 3;
    expect(pointPosition(ctx.points![1])).toEqual([4, 3, 0]);
    expect(() => runtime.executeAction(p, ctx, "robot")).toThrow("地面路径");
    expect(runtime.getExecutionState()).toBeNull();
    if (p.steps[0].type !== "moveTo") throw new Error();
    p.steps[0].path = { mode: "air", via: [{ point: "start" }] };
    p.steps[0].rootHeight = "path";
    runtime.executeAction(p, ctx, "robot");
    runtime.advance(20);
    expect(runtime.getExecutionState()?.position).toEqual([4, 3, 0]);
  });
  it("rejects unplaced/deleted references, duplicate IDs, and invalid heights", () => {
    const ctx = context();
    ctx.points![1].ground = null;
    expect(() => validateAction(plan(), ctx)).toThrow("放置");
    expect(() => validateDocument(doc, [ctx.points![0]])).toThrow("不存在");
    expect(() => validatePoints([points()[0], points()[0]])).toThrow("重复");
    expect(() =>
      validatePoints([{ ...points()[0], height: Infinity }]),
    ).toThrow("高度");
    expect(() =>
      validatePoints([{ ...points()[0], ground: [51, 0, 0] }]),
    ).toThrow("范围");
  });
  it("sends structured text references and point data to the planner without pool or frame data", async () => {
    const result = await planMotion("以 p1 为起点，走到 p2", context(), {
      document: doc,
      fetcher: async (_url, init) => {
        const req = JSON.parse(String(init?.body)),
          input = JSON.parse(req.messages[1].content);
        expect(input.document).toEqual(doc);
        expect(input.points[1]).toMatchObject({
          id: "end",
          position: [4, 0, 0],
        });
        expect(input.capabilities).not.toHaveProperty("poolId");
        expect(input.capabilities.animations[0]).not.toHaveProperty("slot");
        expect(input.capabilities.animations[0]).not.toHaveProperty(
          "animation",
        );
        return new Response(
          JSON.stringify({ ok: true, content: JSON.stringify(plan()) }),
        );
      },
    });
    expect(result).toEqual(plan());
  });
  it("persists text tokens, points and v2 plans without creating pools; rejects invalid references atomically", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lifetime-points-test-"));
    try {
      const store = new Store(dir),
        actor = await store.createActor("Points");
      await store.appendModel(actor.id, revision);
      await store.appendClip(actor.id, clip);
      const value = {
        id: "action",
        name: "Test",
        createdAt: 1,
        updatedAt: 1,
        modelRevisionId: revision.id,
        prompt: "",
        document: [
          ...doc,
          {
            type: "animation" as const,
            clipId: clip.id,
            modelRevisionId: revision.id,
          },
        ],
        points: points(),
        plan: plan(),
      };
      await store.saveMotionAction(actor.id, value);
      const loaded = await new Store(dir).get<
        import("../src/shared/contracts").Actor
      >("actors", actor.id);
      expect(loaded.pools ?? []).toEqual([]);
      expect(loaded.motionActions![0]).toMatchObject({
        document: value.document,
        points: points(),
        plan: plan(),
      });
      await expect(
        store.saveMotionAction(actor.id, { ...value, points: [points()[0]] }),
      ).rejects.toThrow("不存在");
      const unchanged = await store.get<
        import("../src/shared/contracts").Actor
      >("actors", actor.id);
      expect(unchanged.motionActions).toEqual(loaded.motionActions);
    } finally {
      if (
        path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) ||
        !path.basename(dir).startsWith("lifetime-points-test-")
      )
        throw new Error("Unexpected directory");
      await rm(dir, { recursive: true, force: true });
    }
  });
});
