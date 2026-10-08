import { describe, expect, it } from "vitest";
import {
  editAnimation,
  clearAnimation,
  appendAnimation,
  type AnimationEdit,
} from "../src/client/motion/editing";
import { MotionRuntime } from "../src/client/motion/runtime";
import {
  type MotionContext,
  type MotionPlan,
  type PromptPart,
} from "../src/shared/motion";
import { clip, revision } from "./fixtures";
import { Store } from "../src/server/store";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const replacement = { ...clip, id: "replacement", name: "Run" };
const context = (): MotionContext => ({
  actor: {
    id: "actor",
    name: "Robot",
    updatedAt: 1,
    modelRevisions: [revision],
    animations: [clip, replacement],
  },
  modelRevisionId: revision.id,
});
const plan = (): MotionPlan => ({
  schemaVersion: 2,
  name: "Timeline",
  modelRevisionId: revision.id,
  start: [0, 0, 0],
  steps: [
    {
      id: "walk",
      type: "moveTo",
      destination: [10, 0, 0],
      speed: 2,
      animation: { clipId: clip.id, repeat: "untilArrival" },
    },
    { id: "wave", type: "playClip", animation: { clipId: clip.id, repeat: 1 } },
    { id: "wait", type: "wait", seconds: 1 },
  ],
});
const doc: PromptPart[] = [
  { type: "animation", clipId: clip.id, modelRevisionId: revision.id },
];
const edit = (patch: Partial<AnimationEdit> = {}): AnimationEdit => ({
  clipId: clip.id,
  rate: 2,
  start: 0,
  end: 2,
  repeat: 1,
  sync: "independent",
  speed: 2,
  ...patch,
});
describe("action segment editing", () => {
  it("changes wing/leg playback independently from movement duration and destination", () => {
    const ctx = context(),
      input = plan(),
      before = structuredClone(input);
    const next = editAnimation(input, doc, ctx, "walk", -1, edit());
    const r = new MotionRuntime();
    const timings = r.inspectAction(next.plan, ctx);
    expect(timings.map((t) => [t.start, t.end])).toEqual([
      [0, 5],
      [5, 7],
      [7, 8],
    ]);
    expect(r.getExecutionState()).toBeNull();
    r.executeAction(next.plan, ctx, "actor");
    r.advance(0.5);
    expect(r.frame?.position).toEqual([1, 0, 0]);
    expect(r.frame?.animation?.time).toBe(1);
    r.advance(4.5);
    expect(r.frame?.position).toEqual([10, 0, 0]);
    expect(input).toEqual(before);
  });
  it("retimes standalone segments and all later timeline intervals using trimmed source time", () => {
    const ctx = context();
    const next = editAnimation(
      plan(),
      doc,
      ctx,
      "wave",
      -1,
      edit({ start: 0.5, end: 1.5, repeat: 2 }),
    );
    const r = new MotionRuntime();
    expect(
      r.inspectAction(next.plan, ctx).map((t) => [t.start, t.end]),
    ).toEqual([
      [0, 5],
      [5, 6],
      [6, 7],
    ]);
    r.executeAction(next.plan, ctx, "actor");
    r.advance(5.25);
    expect(r.frame?.animation?.time).toBe(1);
  });
  it("makes fitClip arrival explicitly follow playback rate, while speed edits control independent movement", () => {
    const ctx = context(),
      r = new MotionRuntime();
    const fit = editAnimation(
      plan(),
      doc,
      ctx,
      "walk",
      -1,
      edit({ sync: "fitClip" }),
    );
    expect(r.inspectAction(fit.plan, ctx)[0].duration).toBe(1);
    r.executeAction(fit.plan, ctx, "actor");
    r.advance(1);
    expect(r.frame?.position).toEqual([10, 0, 0]);
    const fast = editAnimation(
      plan(),
      doc,
      ctx,
      "walk",
      -1,
      edit({ speed: 5 }),
    );
    expect(r.inspectAction(fast.plan, ctx)[0].duration).toBe(2);
  });
  it("replaces only the chosen use, updating text tokens only when the old animation is no longer used", () => {
    const ctx = context();
    const first = editAnimation(
      plan(),
      doc,
      ctx,
      "walk",
      -1,
      edit({ clipId: replacement.id }),
    );
    expect(first.document).toEqual(doc);
    expect(first.plan.steps[1]).toEqual(plan().steps[1]);
    const second = editAnimation(
      first.plan,
      first.document,
      ctx,
      "wave",
      -1,
      edit({ clipId: replacement.id }),
    );
    expect(second.document[0]).toMatchObject({ clipId: replacement.id });
    expect(ctx.actor.animations[0]).toEqual(clip);
  });
  it("preserves layered node masks and main duration when editing an overlay", () => {
    const p = plan(),
      ctx = context();
    if (p.steps[0].type !== "moveTo") throw new Error();
    p.steps[0].layers = [
      {
        clipId: clip.id,
        nodes: ["arm"],
        weight: 0.5,
        blend: "additive",
        repeat: 2,
      },
    ];
    const next = editAnimation(
      p,
      doc,
      ctx,
      "walk",
      0,
      edit({ clipId: replacement.id, repeat: 2 }),
    );
    expect(next.plan.steps[0]).toMatchObject({
      animation: p.steps[0].animation,
      layers: [
        {
          nodes: ["arm"],
          weight: 0.5,
          blend: "additive",
          clipId: replacement.id,
          rate: 2,
        },
      ],
    });
    expect(new MotionRuntime().inspectAction(next.plan, ctx)[0].duration).toBe(
      5,
    );
  });
  it("rejects invalid rates, slices, model versions and insufficient non-looping animation without changing the source", () => {
    const p = plan(),
      ctx = context(),
      before = structuredClone(p);
    for (const patch of [
      { rate: 0 },
      { rate: NaN },
      { start: 1.5, end: 1 },
      { clipId: "missing" },
    ])
      expect(() =>
        editAnimation(p, doc, ctx, "walk", -1, edit(patch)),
      ).toThrow();
    ctx.actor.animations.push({
      ...replacement,
      id: "foreign",
      modelRevisionId: "other",
    });
    expect(() =>
      editAnimation(p, doc, ctx, "walk", -1, edit({ clipId: "foreign" })),
    ).toThrow("模型版本");
    ctx.actor.animations[1] = {
      ...replacement,
      animation: { ...(clip.animation as object), loop: false },
    };
    const next = editAnimation(
      p,
      doc,
      ctx,
      "walk",
      -1,
      edit({ clipId: replacement.id }),
    );
    expect(() => new MotionRuntime().inspectAction(next.plan, ctx)).toThrow(
      "不足以到达",
    );
    expect(p).toEqual(before);
  });
  it("saves edited clip references, speeds and ranges and restores them unchanged", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lifetime-edit-test-"));
    try {
      const store = new Store(dir),
        actor = await store.createActor("Edit");
      await store.appendModel(actor.id, revision);
      await store.appendClip(actor.id, clip);
      await store.appendClip(actor.id, replacement);
      const edited = editAnimation(
        plan(),
        doc,
        context(),
        "wave",
        -1,
        edit({ clipId: replacement.id, start: 0.5, end: 1.5 }),
      );
      await store.saveMotionAction(actor.id, {
        id: "edited",
        name: "Edit",
        createdAt: 1,
        updatedAt: 1,
        modelRevisionId: revision.id,
        prompt: "",
        ...edited,
      });
      const loaded = await store.get<import("../src/shared/contracts").Actor>(
        "actors",
        actor.id,
      );
      expect(loaded.motionActions![0].plan).toEqual(edited.plan);
      expect(loaded.motionActions![0].document).toEqual(edited.document);
    } finally {
      if (
        path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) ||
        !path.basename(dir).startsWith("lifetime-edit-test-")
      )
        throw new Error("Unexpected directory");
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("independent animation slots", () => {
  it("removes a movement animation without losing its path or destination", () => {
    const ctx = context(),
      source = plan(),
      before = structuredClone(source);
    const removed = clearAnimation(source, doc, ctx, "walk", -1, 5);
    expect(removed.plan.steps[0]).toMatchObject({
      type: "moveTo",
      animation: null,
      speed: 2,
      destination: [10, 0, 0],
      sync: "independent",
    });
    expect(removed.document).toEqual(doc); // The second slot still uses this animation.
    const runtime = new MotionRuntime();
    runtime.executeAction(removed.plan, ctx, "actor");
    runtime.advance(2);
    expect(runtime.frame?.position).toEqual([4, 0, 0]);
    expect(runtime.frame?.animation).toBeUndefined();
    runtime.advance(3);
    expect(runtime.frame?.position).toEqual([10, 0, 0]);
    expect(source).toEqual(before);
  });
  it("keeps empty stationary slot timing, removes unused tokens, and accepts a new animation", () => {
    const ctx = context();
    const removed = clearAnimation(plan(), doc, ctx, "walk", -1, 5);
    const empty = clearAnimation(
      removed.plan,
      removed.document,
      ctx,
      "wave",
      -1,
      2,
    );
    expect(empty.document).toEqual([]);
    expect(empty.plan.steps[1]).toMatchObject({ animation: null, seconds: 2 });
    expect(
      new MotionRuntime().inspectAction(empty.plan, ctx).map((t) => t.duration),
    ).toEqual([5, 2, 1]);
    const filled = editAnimation(
      empty.plan,
      empty.document,
      ctx,
      "wave",
      -1,
      edit({ clipId: replacement.id }),
    );
    expect(filled.plan.steps[1]).not.toHaveProperty("seconds");
    expect(
      new MotionRuntime()
        .inspectAction(filled.plan, ctx)
        .map((t) => t.duration),
    ).toEqual([5, 1, 1]);
  });
  it("adds a clip to an empty plan and rejects incompatible or excessive additions", () => {
    const ctx = context(),
      empty = { ...plan(), steps: [] };
    const added = appendAnimation(empty, [], ctx, replacement.id, "first");
    expect(new MotionRuntime().inspectAction(added.plan, ctx)[0].duration).toBe(
      2,
    );
    expect(empty.steps).toEqual([]);
    expect(() => appendAnimation(empty, [], ctx, "missing", "first")).toThrow();
    expect(() =>
      appendAnimation(added.plan, [], ctx, clip.id, "first"),
    ).toThrow();
    const full = {
      ...plan(),
      steps: Array.from({ length: 100 }, (_, i) => ({
        id: String(i),
        type: "wait" as const,
        seconds: 1,
      })),
    };
    expect(() => appendAnimation(full, [], ctx, clip.id, "extra")).toThrow();
  });
  it("removes only the chosen overlay and validates empty-slot contracts", () => {
    const ctx = context(),
      p = plan();
    if (p.steps[0].type !== "moveTo") throw new Error();
    p.steps[0].layers = [
      { clipId: replacement.id, nodes: ["arm"], repeat: 1 },
    ];
    const removed = clearAnimation(p, doc, ctx, "walk", 0, 5);
    expect(removed.plan.steps[0]).toMatchObject({
      animation: p.steps[0].animation,
      layers: [],
    });
    const runtime = new MotionRuntime();
    expect(() =>
      runtime.inspectAction(
        {
          ...plan(),
          steps: [{ id: "empty", type: "playClip", animation: null }],
        },
        ctx,
      ),
    ).toThrow();
    expect(() =>
      runtime.inspectAction(
        {
          ...plan(),
          steps: [
            {
              id: "empty",
              type: "moveTo",
              animation: null,
              destination: [2, 0, 0],
              speed: 1,
              sync: "fitClip",
            },
          ],
        },
        ctx,
      ),
    ).toThrow();
  });
});
