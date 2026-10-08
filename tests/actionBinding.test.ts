import { describe, it, expect } from "vitest";
import type { Actor } from "../src/shared/contracts";
import {
  actionInputs,
  resolveBoundAction,
  promoteLegacyAction,
  type BoundAction,
} from "../src/shared/actionBinding";
import { createActionTemplate } from "../src/shared/actionTemplates";
import { MotionRuntime } from "../src/client/motion/runtime";
import type { SavedAction, MotionContext } from "../src/shared/motion";
import { revision, clip } from "./fixtures";

const actor: Actor = {
  id: "actor",
  name: "actor",
  updatedAt: 1,
  modelRevisions: [revision],
  animations: [clip],
};
function setup() {
  const draft = createActionTemplate(actor, revision.id, "visit", clip.id, [
    clip.id,
    clip.id,
  ]);
  const source: SavedAction = {
    ...draft,
    id: "visit",
    name: draft.plan.name,
    prompt: "表演并返回",
    modelRevisionId: revision.id,
    createdAt: 1,
    updatedAt: 1,
  };
  const a = { ...actor, motionActions: [source] },
    inputs = actionInputs(source);
  const bound: BoundAction = {
    id: "bound",
    name: "桥上表演",
    actorActionId: source.id,
    actorActionUpdatedAt: 1,
    bindings: Object.fromEntries(
      inputs.map((slot, index) => [slot.id, "scene" + index]),
    ),
  };
  const ctx: MotionContext = {
    actor: a,
    modelRevisionId: revision.id,
    points: [
      { id: "scene0", name: "p1", ground: [5, 0, 0], height: 0 },
      { id: "scene1", name: "p2", ground: [5, 0, 5], height: 0 },
      { id: "scene2", name: "p3", ground: [0, 0, 0], height: 0 },
    ],
  };
  return { a, source, bound, ctx };
}
describe("actor actions and scene bindings", () => {
  it("keeps a complete visit action in Actors and resolves only map inputs without changing the source", () => {
    const { source, bound, ctx } = setup(),
      snapshot = structuredClone(source);
    const plan = resolveBoundAction(ctx.actor, bound, ctx),
      runtime = new MotionRuntime();
    const timings = runtime.inspectAction(plan, ctx);
    expect(plan.steps.map((s) => s.type)).toEqual([
      "moveTo",
      "turnTo",
      "playClip",
      "playClip",
      "moveTo",
    ]);
    runtime.executeAction(plan, ctx, "instance");
    runtime.advance(timings[0].duration + timings[1].duration);
    expect(runtime.getExecutionState()?.heading).toBeCloseTo(0); // bridge faces +Z toward the bound pond point
    runtime.advance(100);
    expect(runtime.getExecutionState()?.position).toEqual([0, 0, 0]);
    expect(source).toEqual(snapshot);
    expect(bound).not.toHaveProperty("plan");
  });
  it("allows incomplete drafts but refuses execution defaults or stale actor versions", () => {
    const { bound, ctx } = setup();
    bound.bindings = {};
    expect(() =>
      resolveBoundAction(
        ctx.actor,
        bound,
        { ...ctx, allowUnplacedPoints: true },
        false,
      ),
    ).not.toThrow();
    expect(() => resolveBoundAction(ctx.actor, bound, ctx)).toThrow(
      "绑定地图点",
    );
    bound.actorActionUpdatedAt = 0;
    expect(() => resolveBoundAction(ctx.actor, bound, ctx)).toThrow(
      "演员动作已修改",
    );
  });
  it("uses different map bindings for one reusable actor action and validates ownership", () => {
    const { bound, ctx } = setup(),
      first = resolveBoundAction(ctx.actor, bound, ctx);
    const second = structuredClone(bound);
    second.bindings[actionInputs(ctx.actor.motionActions![0])[0].id] = "scene2";
    expect(resolveBoundAction(ctx.actor, second, ctx).steps[0]).not.toEqual(
      first.steps[0],
    );
    expect(() =>
      resolveBoundAction(ctx.actor, bound, {
        ...ctx,
        modelRevisionId: "other",
      }),
    ).toThrow("模型版本");
    bound.actorActionId = "missing";
    expect(() => resolveBoundAction(ctx.actor, bound, ctx)).toThrow("不存在");
  });
  it("promotes old scene plans explicitly, preserving map locations and stable scene action IDs", () => {
    const points = [
      {
        id: "old",
        name: "p1",
        ground: [120, -2, 80] as [number, number, number],
        height: 0,
      },
    ];
    const legacy = {
      id: "legacy",
      name: "old action",
      plan: {
        schemaVersion: 2 as const,
        name: "old action",
        modelRevisionId: revision.id,
        steps: [
          {
            id: "move",
            type: "moveTo" as const,
            destination: { point: "old" },
            speed: 3,
            path: { mode: "ground" as const },
            animation: { clipId: clip.id, repeat: "untilArrival" as const },
          },
        ],
      },
    };
    const migration = promoteLegacyAction(legacy, points);
    expect(migration.binding.id).toBe(legacy.id);
    expect(migration.points[0]).toEqual(points[0]);
    expect(migration.source.points![0].ground![0]).toBeLessThanOrEqual(40);
    migration.source.updatedAt = 1;
    migration.binding.actorActionUpdatedAt = 1;
    const plan = resolveBoundAction(
      { ...actor, motionActions: [migration.source] },
      migration.binding,
      {
        actor,
        modelRevisionId: revision.id,
        points: migration.points,
        space: { min: [-200, -10, -200], max: [200, 100, 200] },
      },
    );
    expect(plan.steps[0]).toMatchObject({ destination: { point: "old" } });
  });
  it("binds numeric coordinates and named parameters rather than reusing preview coordinates", () => {
    const { source, bound, ctx } = setup();
    source.plan.steps = [
      {
        id: "m",
        type: "moveTo",
        destination: { parameter: "target" },
        speed: 3,
        animation: { clipId: clip.id, repeat: "untilArrival" },
        path: { mode: "ground", via: [[1, 0, 1]] },
      },
    ];
    source.plan.parameters = { target: { type: "vec3", default: [10, 0, 10] } };
    const slots = actionInputs(source);
    bound.bindings = Object.fromEntries(slots.map((s) => [s.id, "scene0"]));
    const plan = resolveBoundAction(ctx.actor, bound, ctx);
    expect(plan.parameters).toBeUndefined();
    expect(plan.steps[0]).toMatchObject({
      destination: { point: "scene0" },
      path: { via: [{ point: "scene0" }] },
    });
  });
});
