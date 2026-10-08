import { describe, it, expect } from "vitest";
import { normalizeMap } from "../src/client/rendering/map/shared/map";
import { buildSemanticIndex } from "../src/client/navigation/semanticIndex";
import { buildSceneGeometry } from "../src/client/navigation/geometry";
import { Navigation } from "../src/client/navigation/navigation";
import { LocationResolver } from "../src/client/navigation/locationResolver";
import {
  sceneCatalogue,
  validateScenePlan,
  currentScenePlan,
  type ScenePlan,
} from "../src/shared/scenePlan";
import { assembleScene } from "../src/client/scene/performanceAssembler";
import { planScene } from "../src/client/scene/planner";
import { revision, clip } from "./fixtures";
import type { Actor, Performance } from "../src/shared/contracts";
import type { MapResource } from "../src/shared/maps";
import { pointPosition } from "../src/shared/motion";

import {
  sceneActor,
  sceneMap,
  baseScene,
  scenePlan,
  assemblyFixture,
} from "./sceneFixtures";
describe("semantic scene planning", () => {
  it("sends a compact catalogue without model nodes, water vertices, geometry or coordinates", () => {
    const index = buildSemanticIndex(sceneMap),
      catalogue = sceneCatalogue(index.summary, [sceneActor], []),
      json = JSON.stringify(catalogue);
    expect(
      index.summary.features.find((f) => f.id === "object:bridge")?.queries,
    ).toContain("center");
    expect(json).not.toMatch(
      /"(?:modelJson|nodes|collisionBake|terrain|position|points|animation)"\s*:/,
    );
    expect(
      validateScenePlan(scenePlan(), catalogue).actors[0].states,
    ).toHaveLength(2);
  });
  it("rejects invented assets, arbitrary coordinates, incompatible loop clips and invalid state references", () => {
    const catalogue = sceneCatalogue(
      buildSemanticIndex(sceneMap).summary,
      [sceneActor],
      [],
    );
    const invalid = scenePlan() as any;
    invalid.actors[0].locations[0].position = [1, 0, 1];
    expect(() => validateScenePlan(invalid, catalogue)).toThrow();
    delete invalid.actors[0].locations[0].position;
    invalid.actors[0].actions[0].steps[0].animation = "fake";
    expect(() => validateScenePlan(invalid, catalogue)).toThrow("循环动画");
    invalid.actors[0].actions[0].steps[0].animation = clip.id;
    invalid.actors[0].states[0].next = "missing";
    expect(() => validateScenePlan(invalid, catalogue)).toThrow("状态引用");
  });
  it("uses one planner request and treats missing capabilities as an explicit failure", async () => {
    const catalogue = sceneCatalogue(
      buildSemanticIndex(sceneMap).summary,
      [sceneActor],
      [],
    );
    let calls = 0;
    const fetcher = async (_url: unknown, init: any) => {
      calls++;
      const body = JSON.parse(init.body);
      expect(body.messages[1].content).not.toContain('"position"');
      return new Response(
        JSON.stringify({ content: JSON.stringify(scenePlan()) }),
        { status: 200 },
      );
    };
    expect(
      (
        await planScene("make a court", catalogue, {
          fetcher: fetcher as typeof fetch,
        })
      ).actors,
    ).toHaveLength(1);
    expect(calls).toBe(1);
    await expect(
      planScene("make a court", catalogue, {
        fetcher: async () =>
          new Response(
            JSON.stringify({ content: '{"error":"missing farmer"}' }),
          ),
      }),
    ).rejects.toThrow("missing farmer");
  });
  it("finds an exterior closed circuit, a supported bridge center, and a water-facing point locally", async () => {
    const f = await assemblyFixture();
    try {
      const resolver = new LocationResolver(
        buildSemanticIndex(sceneMap),
        f.geometry,
        f.nav,
      );
      const route = await resolver.resolve(scenePlan().actors[0].locations[0]);
      expect(route.closed).toBe(true);
      expect(route.points).toHaveLength(4);
      const bridge = await resolver.resolve(scenePlan().actors[0].locations[1]);
      expect(pointPosition(bridge.points[0])[1]).toBeCloseTo(0.3);
      expect(bridge.points[0].surface?.objectId).toBe("bridge");
      const facing = await resolver.resolve(scenePlan().actors[0].locations[2]);
      expect(facing.points[0].ground).toEqual([0, 0.2, 1.5]);
      expect(() => f.nav.project(facing.points[0].ground!)).toThrow(); // Facing points don't have to be standing surfaces.
    } finally {
      f.dispose();
    }
  });
  it("compiles two complete actor actions and two bound states, without mutating the source or base", async () => {
    const f = await assemblyFixture(),
      before = structuredClone(sceneActor);
    try {
      const result = await assembleScene(scenePlan(), f.context),
        i = result.performance.instances[0];
      expect(i.sceneMotion?.points).toHaveLength(6);
      expect(i.sceneMotion?.machine?.states).toHaveLength(2);
      expect(result.actions).toHaveLength(2);
      expect(i.sceneMotion?.actions.every((a) => !("plan" in a))).toBe(true);
      expect(result.actions[1].action.plan.steps.map((s) => s.type)).toEqual([
        "moveTo",
        "turnTo",
        "playClip",
        "moveTo",
      ]);
      expect(
        result.actions[1].action.points?.every((p) => p.ground?.[1] === 0),
      ).toBe(true);
      expect(sceneActor).toEqual(before);
      expect(baseScene.instances).toEqual([]);
    } finally {
      f.dispose();
    }
  });
  it("edits repetitions without regenerating complete actions and preserves manual points", async () => {
    const f = await assemblyFixture();
    try {
      const first = await assembleScene(scenePlan(), f.context),
        actor = structuredClone(sceneActor);
      actor.motionActions = first.actions.map((a) => a.action);
      const base = first.performance,
        instance = base.instances[0];
      instance.sceneMotion!.points[0].ground![0] += 0.15;
      delete instance.sceneMotion!.points[0].surface;
      const plan = scenePlan();
      plan.actors[0].instanceId = instance.id;
      plan.actors[0].states[0].repetitions = 3;
      const second = await assembleScene(plan, {
        ...f.context,
        base,
        actors: new Map([[actor.id, actor]]),
      });
      expect(second.actions).toHaveLength(0);
      expect(second.performance.instances[0].sceneMotion!.points).toEqual(
        instance.sceneMotion!.points,
      );
      expect(
        second.performance.instances[0].sceneMotion!.machine!.states[0]
          .repetitions,
      ).toBe(3);
      second.performance.instances[0].sceneMotion!.machine!.states[0].repetitions = 4;
      expect(
        currentScenePlan(second.performance)!.actors[0].states[0].repetitions,
      ).toBe(4);
      expect(
        JSON.stringify(currentScenePlan(second.performance)),
      ).not.toContain('"ground"');
    } finally {
      f.dispose();
    }
  });
  it("does not publish an unreachable bridge by silently increasing actor climbing ability", async () => {
    const map = structuredClone(sceneMap);
    map.map.objects[0].transform.position[1] = 2;
    const geometry = await buildSceneGeometry(map.map),
      nav = new Navigation({ radius: 0.3, height: 3, climb: 0.3, slope: 35 });
    try {
      await nav.build(geometry);
      await expect(
        assembleScene(scenePlan(), {
          map,
          actors: new Map([[sceneActor.id, sceneActor]]),
          base: baseScene,
          request: "go to bridge",
          geometry,
          navigation: async () => nav,
          climb: 0.3,
        }),
      ).rejects.toThrow();
      expect(nav.profile.climb).toBe(0.3);
    } finally {
      nav.dispose();
      geometry.dispose();
    }
  });
  it("preserves an edited point across state-only and later action updates", async () => {
    const f = await assemblyFixture();
    try {
      const first = await assembleScene(scenePlan(), f.context),
        actor = structuredClone(sceneActor);
      actor.motionActions = first.actions.map((a) => a.action);
      const base = first.performance,
        instance = base.instances[0],
        point = instance.sceneMotion!.points[0];
      point.ground![0] += 0.1;
      delete point.surface;
      const plan = structuredClone(base.sceneDesign!.plan);
      plan.actors[0].states[0].repetitions = 2;
      const second = await assembleScene(plan, {
        ...f.context,
        base,
        actors: new Map([[actor.id, actor]]),
      });
      const update = structuredClone(second.performance.sceneDesign!.plan);
      update.actors[0].actions[0].steps[0].type === "followRoute" &&
        (update.actors[0].actions[0].steps[0].rate = 1.5);
      const third = await assembleScene(update, {
        ...f.context,
        base: second.performance,
        actors: new Map([[actor.id, actor]]),
      });
      expect(
        third.performance.instances[0].sceneMotion!.points.find(
          (p) => p.id === point.id,
        ),
      ).toEqual(point);
      expect(third.performance.sceneDesign!.roles[0].points[0]).not.toEqual(
        point,
      );
    } finally {
      f.dispose();
    }
  });
  it("keeps untouched characters and rejects duplicate logical role keys", async () => {
    const f = await assemblyFixture();
    try {
      const first = await assembleScene(scenePlan(), f.context),
        actor = structuredClone(sceneActor);
      actor.motionActions = first.actions.map((a) => a.action);
      const plan = scenePlan();
      plan.actors[0].key = "second";
      const second = await assembleScene(plan, {
        ...f.context,
        base: first.performance,
        actors: new Map([[actor.id, actor]]),
      });
      expect(second.performance.instances[0]).toEqual(
        first.performance.instances[0],
      );
      expect(second.performance.instances).toHaveLength(2);
      await expect(
        assembleScene(scenePlan(), {
          ...f.context,
          base: first.performance,
          actors: new Map([[actor.id, actor]]),
        }),
      ).rejects.toThrow("标识与保留角色重复");
    } finally {
      f.dispose();
    }
  });
  it("rejects malformed planner output without retrying", async () => {
    const catalogue = sceneCatalogue(
      buildSemanticIndex(sceneMap).summary,
      [sceneActor],
      [],
    );
    let calls = 0;
    await expect(
      planScene("patrol", catalogue, {
        fetcher: async () => {
          calls++;
          return new Response(JSON.stringify({ content: "invalid JSON" }));
        },
      }),
    ).rejects.toThrow("合法JSON");
    expect(calls).toBe(1);
  });
});
