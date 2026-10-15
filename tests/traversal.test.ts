import { describe, expect, it } from "vitest";
import { normalizeMap } from "../src/client/rendering/map/shared/map";
import { buildSceneGeometry } from "../src/client/navigation/geometry";
import { Navigation } from "../src/client/navigation/navigation";
import { TraversalClearance } from "../src/client/navigation/traversalClearance";
import {
  TraversalPlanner,
  jumpArc,
} from "../src/client/navigation/traversalPlanner";
import { adaptTraversal } from "../src/client/navigation/adaptTraversal";
import { MotionRuntime } from "../src/client/motion/runtime";
import type { MotionContext, MotionPlan } from "../src/shared/motion";
import { revision, clip } from "./fixtures";
import type { Actor } from "../src/shared/contracts";

function object(id: string, position: number[], size: number[]) {
  return {
    id,
    name: id,
    assetId: null,
    visible: true,
    transform: { position, rotation: [0, 0, 0], scale: size, size: [1, 1, 1] },
  };
}
async function setup(
  objects = [object("platform", [0, 0, 0], [4, 1.5, 4])],
  fly = false,
) {
  const map = normalizeMap({ box: { size: [24, 12, 24] }, objects } as any);
  const geometry = await buildSceneGeometry(map);
  const nav = new Navigation({
    radius: 0.3,
    height: 1.5,
    climb: 0.3,
    slope: 35,
  });
  await nav.build(geometry);
  const clearance = new TraversalClearance(geometry, map, nav.profile);
  return {
    map,
    nav,
    geometry,
    clearance,
    planner: new TraversalPlanner(nav, clearance, {
      fly,
      jumpHeight: 2.5,
      jumpDistance: 5,
    }),
    dispose() {
      clearance.dispose();
      nav.dispose();
      geometry.dispose();
    },
  };
}
describe("map traversal", () => {
  it("walks to a takeoff, jumps onto a disconnected raised surface and walks down via a jump", async () => {
    const s = await setup();
    try {
      const route = s.planner.route([-7, 0, 0], [0, 1.5, 0]);
      expect(route.some((leg) => leg.kind === "jump")).toBe(true);
      expect(route[0].points[0][0]).toBeCloseTo(-7, 1);
      expect(Math.abs(route.at(-1)!.points.at(-1)![1] - 1.5)).toBeLessThan(0.1);
      for (const leg of route.filter((l) => l.kind === "jump"))
        expect(
          s.clearance.clearPath(
            jumpArc(leg.points[0], leg.points.at(-1)!, leg.arc!),
          ),
        ).toBe(true);
      expect(
        s.planner
          .route([0, 1.5, 0], [-7, 0, 0])
          .some((leg) => leg.kind === "jump"),
      ).toBe(true);
    } finally {
      s.dispose();
    }
  });
  it("keeps connected ground routes unchanged and never treats an unsupported air point as a landing", async () => {
    const s = await setup([]);
    try {
      expect(s.planner.route([-5, 0, 0], [5, 0, 0]).map((l) => l.kind)).toEqual(
        ["ground"],
      );
      expect(() => s.planner.route([-5, 0, 0], [0, 5, 0])).toThrow("飞行");
    } finally {
      s.dispose();
    }
  });
  it("flies to air targets only with permission, detours over a wall and checks solid interiors and ceilings", async () => {
    const s = await setup([object("wall", [0, 0, 0], [1, 5, 12])], true);
    try {
      const route = s.planner.route([-4, 0, 0], [4, 3, 0]);
      expect(route.some((leg) => leg.kind === "fly")).toBe(true);
      expect(route.at(-1)!.points.at(-1)).toEqual([4, 3, 0]);
      expect(s.clearance.clearPath(route[0].points)).toBe(true);
      expect(
        Math.max(...route[0].points.map((p) => p[1])),
      ).toBeGreaterThanOrEqual(5);
      expect(() => s.planner.route([-4, 0, 0], [0, 1, 0])).toThrow();
      expect(
        s.clearance.clearPath([
          [-4, 1, 0],
          [4, 1, 0],
        ]),
      ).toBe(false);
    } finally {
      s.dispose();
    }
    const ceiling = await setup([object("ceiling", [0, 1.8, 0], [8, 1, 8])]);
    try {
      expect(
        ceiling.clearance.clearPath(jumpArc([-2, 0, 0], [2, 0, 0], 1)),
      ).toBe(false);
    } finally {
      ceiling.dispose();
    }
  });
  it("uses version-bound jump clips, fits one jump cycle and preserves source actions and exact destinations", async () => {
    const s = await setup();
    try {
      const jump = { ...clip, id: "jump", name: "导航跳跃" };
      const actor: Actor = {
        id: "actor",
        name: "actor",
        updatedAt: 1,
        animations: [clip, jump],
        modelRevisions: [revision],
      };
      const ctx: MotionContext = {
        actor,
        modelRevisionId: revision.id,
        space: { min: [-12, -12, -12], max: [12, 100, 12] },
      };
      const plan: MotionPlan = {
        schemaVersion: 2,
        name: "go",
        modelRevisionId: revision.id,
        steps: [
          {
            id: "go",
            type: "moveTo",
            destination: [0, 1.5, 0],
            speed: 3,
            animation: { clipId: clip.id, repeat: "untilArrival" },
            path: { mode: "ground" },
          },
        ],
      };
      const original = structuredClone(plan);
      const adapted = adaptTraversal(plan, ctx, [-7, 0, 0], s.planner);
      expect(adapted.required).toEqual(["jump"]);
      expect(adapted.missing).toEqual([]);
      const runtime = new MotionRuntime({
        route: (from, to, via) => s.nav.route(from, to, via),
      });
      runtime.executeAction(adapted.plan, ctx, "npc", {}, [-7, 0, 0]);
      runtime.advance(100);
      expect(
        Math.abs(runtime.getExecutionState()!.position[1] - 1.5),
      ).toBeLessThan(0.1);
      expect(plan).toEqual(original);
      actor.animations = [{ ...jump, modelRevisionId: "other" }, clip];
      expect(adaptTraversal(plan, ctx, [-7, 0, 0], s.planner).missing).toEqual([
        "jump",
      ]);
    } finally {
      s.dispose();
    }
  });
});
