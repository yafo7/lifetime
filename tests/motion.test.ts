import { describe, expect, it } from "vitest";
import type { Actor, ActionPool } from "../src/shared/contracts";
import {
  validateAction,
  type MotionContext,
  type MotionPlan,
} from "../src/shared/motion";
import { MotionRuntime } from "../src/client/motion/runtime";
import { planMotion } from "../src/client/services/motionPlanner";
import { clip, revision } from "./fixtures";
const pool: ActionPool = {
  id: "pool",
  name: "Test",
  createdAt: 1,
  modelRevisionId: revision.id,
  clipIds: [clip.id],
  entries: [
    {
      slot: "walk",
      clipId: clip.id,
      segments: [{ name: "full", start: 0, end: clip.duration, loop: true }],
      referenceSpeed: 2,
    },
  ],
};
const actor: Actor = {
  id: "actor",
  name: "Test",
  updatedAt: 1,
  modelRevisions: [revision],
  animations: [clip],
  pools: [pool],
};
const ctx: MotionContext = { actor, pool };
const plan = (): MotionPlan => ({
  schemaVersion: 1,
  name: "Return",
  modelRevisionId: revision.id,
  poolId: pool.id,
  parameters: { destination: { type: "vec3" } },
  steps: [
    {
      id: "out",
      type: "moveTo",
      destination: { parameter: "destination" },
      speed: 2,
      animation: { slot: "walk", repeat: "untilArrival" },
      markers: [{ name: "half", at: 0.5 }],
    },
    {
      id: "back",
      type: "moveTo",
      destination: { context: "actionStartPosition" },
      speed: 2,
      animation: { slot: "walk", repeat: "untilArrival" },
    },
  ],
});
describe("structured motion execution", () => {
  it("seeks across steps and backwards without firing skipped arrival events", () => {
    const runtime = new MotionRuntime(),
      events: string[] = [];
    runtime.subscribe((e) => events.push(e.type));
    const id = runtime.executeAction(
      plan(),
      ctx,
      "actor",
      { destination: [10, 0, 0] },
      [4, 0, 0],
    );
    runtime.pauseExecution(id);
    runtime.seekExecution(id, 4);
    expect(runtime.getExecutionState()).toMatchObject({
      status: "paused",
      stepId: "back",
      elapsed: 4,
      position: [8, 0, 0],
    });
    runtime.seekExecution(id, 1);
    expect(runtime.getExecutionState()?.position).toEqual([6, 0, 0]);
    runtime.resumeExecution(id);
    runtime.advance(1);
    expect(runtime.getExecutionState()?.position).toEqual([8, 0, 0]);
    runtime.seekExecution(id, 6);
    expect(runtime.getExecutionState()).toMatchObject({
      status: "completed",
      position: [4, 0, 0],
    });
    runtime.seekExecution(id, 3);
    expect(runtime.getExecutionState()).toMatchObject({
      status: "paused",
      stepId: "back",
      position: [10, 0, 0],
    });
    expect(events).not.toContain("destinationReached");
    expect(() => runtime.seekExecution(id, NaN)).toThrow();
  });
  it("arrives exactly, returns to execution start, emits markers once and preserves input", () => {
    const r = new MotionRuntime(),
      events: string[] = [],
      p = plan(),
      before = structuredClone(p);
    r.subscribe((e) => events.push(e.type + (e.marker ?? "")));
    r.executeAction(p, ctx, "duck", { destination: [10, 0, 0] }, [4, 0, 0]);
    r.advance(3);
    expect(r.getExecutionState()?.position).toEqual([10, 0, 0]);
    r.advance(3);
    expect(r.getExecutionState()).toMatchObject({
      status: "completed",
      position: [4, 0, 0],
      elapsed: 6,
    });
    expect(events.filter((e) => e === "destinationReached")).toHaveLength(2);
    expect(events.filter((e) => e === "markerReachedhalf")).toHaveLength(1);
    expect(p).toEqual(before);
  });
  it("pause freezes space and time, conflicts reject without disturbing execution", () => {
    const r = new MotionRuntime(),
      id = r.executeAction(plan(), ctx, "a", { destination: [10, 0, 0] });
    r.advance(1);
    r.pauseExecution(id);
    const before = r.getExecutionState();
    r.advance(200);
    expect(r.getExecutionState()).toEqual(before);
    expect(() =>
      r.executeAction(plan(), ctx, "a", { destination: [5, 0, 0] }),
    ).toThrow("已有");
    r.resumeExecution(id);
    r.advance(1);
    expect(r.getExecutionState()?.position).toEqual([4, 0, 0]);
    r.cancelExecution(id);
    const cancelled = r.getExecutionState();
    r.advance(100);
    expect(r.getExecutionState()).toEqual(cancelled);
    expect(() => r.pauseExecution("wrong")).toThrow("不存在");
  });
  it("rejects invalid later steps before any movement and verifies targets", () => {
    const r = new MotionRuntime(),
      p = plan();
    p.steps.push({
      id: "bad",
      type: "playClip",
      animation: { slot: "missing" },
    });
    expect(() =>
      r.executeAction(p, ctx, "a", { destination: [2, 0, 0] }),
    ).toThrow("动画不存在");
    expect(r.getExecutionState()).toBeNull();
    expect(() =>
      r.executeAction(plan(), ctx, "a", { destination: [60, 0, 0] }),
    ).toThrow("超出");
    expect(() => r.executeAction(plan(), ctx, "a", {})).toThrow("缺少参数");
    expect(() =>
      validateAction({ ...plan(), script: "anything" }, ctx),
    ).toThrow("不支持的字段");
  });
  it("synchronizes flight landing and clip endpoint with rate changes", () => {
    const p: MotionPlan = {
      ...plan(),
      parameters: {},
      steps: [
        {
          id: "fly",
          type: "moveTo",
          destination: [10, 0, 0],
          speed: 5,
          path: { mode: "air", height: 3 },
          sync: "fitClip",
          animation: {
            slot: "walk",
            start: 0.5,
            end: 1.5,
            rate: 0.5,
            repeat: 1,
          },
          markers: [{ name: "land", at: 1 }],
        },
      ],
    };
    const r = new MotionRuntime();
    r.executeAction(p, ctx, "a");
    r.advance(1);
    r.frame!.position.forEach((v, i) => expect(v).toBeCloseTo([5, 3, 0][i]));
    expect(r.frame?.animation?.time).toBe(1);
    r.advance(1);
    expect(r.frame?.position).toEqual([10, 0, 0]);
    expect(r.frame?.animation?.time).toBe(1.5);
    expect(r.frame?.rootHeight).toBe("path");
    expect(r.getExecutionState()?.status).toBe("completed");
  });
  it("supports waypoint travel, turns, waits and independent instances", () => {
    const p: MotionPlan = {
      ...plan(),
      parameters: {},
      steps: [
        {
          id: "walk",
          type: "moveTo",
          destination: [4, 0, 4],
          path: { mode: "ground", via: [[4, 0, 0]] },
          speed: 4,
          animation: { slot: "walk", repeat: "untilArrival" },
        },
        { id: "turn", type: "turnTo", heading: 180, speed: 180 },
        { id: "wait", type: "wait", seconds: 1 },
      ],
    };
    const a = new MotionRuntime(),
      b = new MotionRuntime();
    a.executeAction(p, ctx, "a");
    b.executeAction(p, ctx, "b");
    a.advance(1);
    expect(a.frame?.position).toEqual([4, 0, 0]);
    expect(b.frame?.position).toEqual([0, 0, 0]);
    a.advance(3);
    expect(a.getExecutionState()?.status).toBe("completed");
    expect(a.frame?.heading).toBeCloseTo(Math.PI);
  });
  it("rejects unsafe loops, masks and uncalibrated speed coupling", () => {
    const p = plan(),
      noLoop = structuredClone(ctx);
    noLoop.pool!.entries![0].segments[0].loop = false;
    expect(() => validateAction(p, noLoop)).toThrow("未声明可循环");
    const move = p.steps[0];
    if (move.type !== "moveTo") throw new Error();
    move.layers = [{ slot: "walk", nodes: ["unknown"] }];
    expect(() => validateAction(p, ctx)).toThrow("不存在的节点");
    move.layers = [];
    move.sync = "locomotion";
    const uncalibrated = structuredClone(ctx);
    delete uncalibrated.pool!.entries![0].referenceSpeed;
    expect(() => validateAction(p, uncalibrated)).toThrow("未标定");
  });
});

describe("text motion planning", () => {
  it("sends only capability data and validates a fixed chat response", async () => {
    const result = await planMotion("走到目标点再回来", ctx, {
      fetcher: async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        expect(request.stream).toBe(false);
        expect(request.messages[1].content).not.toContain('"animation":{');
        return new Response(
          JSON.stringify({ ok: true, content: JSON.stringify(plan()) }),
        );
      },
    });
    expect(result.steps).toHaveLength(2);
  });
  it("does not retry or execute invalid planner output", async () => {
    let requests = 0;
    await expect(
      planMotion("fly", ctx, {
        fetcher: async () => {
          requests++;
          return new Response(
            JSON.stringify({ content: '{"error":"缺少飞行动画"}' }),
          );
        },
      }),
    ).rejects.toThrow("缺少飞行");
    expect(requests).toBe(1);
  });
});
