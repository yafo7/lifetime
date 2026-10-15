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
import {
  assembleScene,
  AssemblyNeedsRepair,
} from "../src/client/scene/performanceAssembler";
import { planScene } from "../src/client/scene/planner";
import { revision, clip } from "./fixtures";
import type { Actor, Performance } from "../src/shared/contracts";
import type { MapResource } from "../src/shared/maps";
import type { AssemblyDraft } from "../src/shared/sceneBuild";
import { pointPosition } from "../src/shared/motion";
import {
  bodiesOverlap,
  characterBody,
} from "../src/client/navigation/characterCollision";

import {
  sceneActor,
  sceneMap,
  baseScene,
  scenePlan,
  assemblyFixture,
} from "./sceneFixtures";
describe("semantic scene planning", () => {
  it("allocates six independent waiting NPCs at one semantic place, preserves existing NPCs, and restores separated checkpoints", async () => {
    const f = await assemblyFixture();
    let draft: AssemblyDraft | undefined;
    try {
      const plan = scenePlan();
      const waiting = {
        ...plan.actors[0],
        key: "servant1",
        name: "仆人1",
        origin: "door",
        locations: [
          {
            key: "door",
            featureId: "object:bridge",
            relation: "near" as const,
          },
        ],
        actions: [
          {
            key: "wait",
            name: "门口等候",
            steps: [{ type: "wait" as const, seconds: 2 }],
          },
        ],
        states: [
          {
            key: "wait",
            name: "等候",
            action: "wait",
            repetitions: 1,
            waitSeconds: 0,
            next: "wait",
          },
        ],
        initialState: "wait",
      };
      plan.actors = [waiting];
      const first = await assembleScene(plan, f.context),
        actor = structuredClone(sceneActor);
      actor.motionActions = first.actions.map((a) => a.action);
      const preserved = structuredClone(first.performance.instances[0]);
      plan.actors = Array.from({ length: 5 }, (_, n) => ({
        ...structuredClone(waiting),
        key: `servant${n + 2}`,
        name: `仆人${n + 2}`,
      }));
      const context = {
        ...f.context,
        base: first.performance,
        actors: new Map([[actor.id, actor]]),
        checkpoint: async (value: AssemblyDraft) => {
          draft = structuredClone(value);
        },
      };
      const result = await assembleScene(plan, context);
      expect(result.performance.instances).toHaveLength(6);
      expect(result.performance.instances[0]).toEqual(preserved);
      const bodies = result.performance.instances.map((i) =>
        characterBody(i, actor),
      );
      for (let a = 0; a < bodies.length; a++)
        for (let b = a + 1; b < bodies.length; b++)
          expect(bodiesOverlap(bodies[a], bodies[b])).toBe(false);
      for (const npc of result.performance.instances) {
        expect(() => f.nav.project(npc.position)).not.toThrow();
        expect(npc.sceneMotion!.machine!.states).toHaveLength(1);
      }
      const resumed = await assembleScene(plan, { ...context, draft });
      expect(resumed.performance.instances.map((i) => i.position)).toEqual(
        result.performance.instances.map((i) => i.position),
      );
      const role = draft!.roles.servant2,
        point = role.locations.door.points[0];
      point.ground = [...preserved.position];
      delete point.surface;
      role.locations.door.manual = true;
      await expect(
        assembleScene(plan, { ...context, draft }),
      ).rejects.toBeInstanceOf(AssemblyNeedsRepair);
      expect(draft!.roles.servant2.locations.door.state).toBe("needs-repair");
      expect(
        draft!.roles.servant2.issues.some(
          (i) => i.code === "CHARACTER_SPACE_OCCUPIED",
        ),
      ).toBe(true);
    } finally {
      f.dispose();
    }
  });
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
  it("adapts a raised bridge using jump links without silently increasing actor climbing ability", async () => {
    const map = structuredClone(sceneMap);
    map.map.objects[0].transform.position[1] = 2;
    const geometry = await buildSceneGeometry(map.map),
      nav = new Navigation({ radius: 0.3, height: 3, climb: 0.3, slope: 35 });
    try {
      await nav.build(geometry);
      const result = await assembleScene(scenePlan(), {
        map,
        actors: new Map([[sceneActor.id, sceneActor]]),
        base: baseScene,
        request: "go to bridge",
        geometry,
        navigation: async () => nav,
        climb: 0.3,
      });
      expect(
        result.performance.instances[0].sceneMotion!.navigation.climb,
      ).toBe(0.3);
      expect(
        result.actions.every(({ action }) =>
          action.plan.steps.every(
            (step) => step.type !== "moveTo" || step.path?.mode === "ground",
          ),
        ),
      ).toBe(true);
      expect(nav.profile.climb).toBe(0.3);
    } finally {
      nav.dispose();
      geometry.dispose();
    }
  });
  it("replaces an existing role model and rebuilds complete actions against its new clips", async () => {
    const f = await assemblyFixture();
    try {
      const first = await assembleScene(scenePlan(), f.context);
      const actor = structuredClone(sceneActor);
      actor.motionActions = first.actions.map((item) => item.action);
      const model = { ...structuredClone(revision), id: "replacement-model" };
      const animation = {
        ...structuredClone(clip),
        id: "replacement-clip",
        modelRevisionId: model.id,
      };
      actor.modelRevisions.push(model);
      actor.animations.push(animation);
      first.performance.instances[0].scale = 9;
      const plan = scenePlan();
      plan.actors[0].instanceId = first.performance.instances[0].id;
      plan.actors[0].modelRevisionId = model.id;
      for (const action of plan.actors[0].actions)
        for (const step of action.steps)
          if ("animation" in step) step.animation = animation.id;
      const second = await assembleScene(plan, {
        ...f.context,
        base: first.performance,
        actors: new Map([[actor.id, actor]]),
      });
      const instance = second.performance.instances[0];
      expect(instance.id).toBe(first.performance.instances[0].id);
      expect(instance.modelRevisionId).toBe(model.id);
      expect(instance.scale).not.toBe(9);
      expect(second.actions).toHaveLength(2);
      expect(
        second.actions.every(
          (item) => item.action.modelRevisionId === model.id,
        ),
      ).toBe(true);
      expect(
        instance.sceneMotion!.actions.every((binding) =>
          first.performance.instances[0].sceneMotion!.actions.every(
            (old) =>
              "actorActionId" in old &&
              "actorActionId" in binding &&
              old.actorActionId !== binding.actorActionId,
          ),
        ),
      ).toBe(true);
      expect(first.performance.instances[0].modelRevisionId).toBe(revision.id);
    } finally {
      f.dispose();
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
  it("snaps a guide near a NavMesh boundary without weakening execution projection", async () => {
    const f = await assemblyFixture();
    try {
      const map = structuredClone(sceneMap);
      map.map.guides = [
        {
          id: "edge",
          name: "edge",
          points: [
            [8, 8],
            [9.95, 8],
          ],
          curve: "polyline",
          closed: false,
          width: 1,
          tags: ["path"],
        },
      ];
      expect(() => f.nav.project([9.95, 0, 8])).toThrow();
      const result = await new LocationResolver(
        buildSemanticIndex(map),
        f.geometry,
        f.nav,
      ).resolve({
        key: "edge",
        featureId: "guide:edge",
        relation: "alongGuide",
      });
      const last = pointPosition(result.points.at(-1)!);
      expect(Math.abs(last[0] - 9.95)).toBeLessThanOrEqual(0.65);
      expect(() => f.nav.project(last)).not.toThrow();
      expect(
        f.nav.route(pointPosition(result.points[0]), last).length,
      ).toBeGreaterThan(1);
    } finally {
      f.dispose();
    }
  });
  it("retains the standing surface when a raised center is disconnected", async () => {
    const map = structuredClone(sceneMap);
    map.map.objects[0].transform.position[1] = 2;
    const geometry = await buildSceneGeometry(map.map),
      nav = new Navigation({ radius: 0.3, height: 3, climb: 0.3, slope: 35 });
    try {
      await nav.build(geometry);
      const resolver = new LocationResolver(
        buildSemanticIndex(map),
        geometry,
        nav,
      );
      let error: any;
      try {
        await resolver.resolve(
          { key: "center", featureId: "object:bridge", relation: "center" },
          [6, 0, 5],
        );
      } catch (e) {
        error = e;
      }
      expect(error.code).toBe("TARGET_UNREACHABLE");
      expect(pointPosition(error.points[0])[1]).toBeCloseTo(2.2);
      expect(error.points[0].surface.objectId).toBe("bridge");
      expect(nav.profile.climb).toBe(0.3);
    } finally {
      nav.dispose();
      geometry.dispose();
    }
  });
  it("retains independent actions and stable inputs after a location fails, then accepts manual repair", async () => {
    const f = await assemblyFixture();
    let draft: AssemblyDraft | undefined;
    const checkpoint = async (value: AssemblyDraft) => {
      draft = structuredClone(value);
    };
    const resolve = LocationResolver.prototype.resolve;
    let fail = true;
    LocationResolver.prototype.resolve = async function (intent, from) {
      if (intent.key === "show" && fail) throw new Error("blocked support");
      return resolve.call(this, intent, from);
    };
    try {
      await expect(
        assembleScene(scenePlan(), { ...f.context, checkpoint }),
      ).rejects.toBeInstanceOf(AssemblyNeedsRepair);
      expect(draft!.roles.duck.locations.show.state).toBe("needs-repair");
      expect(draft!.roles.duck.actions.patrol.state).toBe("ready");
      expect(draft!.roles.duck.actions.show.state).toBe("needs-repair");
      const original = structuredClone(draft!);
      const instanceId = draft!.roles.duck.instanceId;
      const actionId = draft!.roles.duck.actions.patrol.action!.id;
      fail = false;
      const candidate = await new LocationResolver(
        buildSemanticIndex(sceneMap),
        f.geometry,
        f.nav,
      ).resolve(scenePlan().actors[0].locations[1]);
      const location = draft!.roles.duck.locations.show;
      location.points[0] = {
        ...candidate.points[0],
        id: location.points[0].id,
        name: location.points[0].name,
      };
      location.manual = true;
      location.state = "pending";
      const result = await assembleScene(scenePlan(), {
        ...f.context,
        draft,
        checkpoint,
      });
      expect(result.performance.instances[0].id).toBe(instanceId);
      expect(result.actions[0].action.id).toBe(actionId);
      expect(draft!.state).toBe("ready");
      expect(draft!.roles.duck.locations.show.manual).toBe(true);
      expect(draft!.roles.duck.locations.circuit.points).toEqual(
        original.roles.duck.locations.circuit.points,
      );
      expect(baseScene.instances).toEqual([]);
    } finally {
      LocationResolver.prototype.resolve = resolve;
      f.dispose();
    }
  });
  it("keeps another role complete when one role fails, and stops immediately on checkpoint storage failure", async () => {
    const f = await assemblyFixture();
    const plan = scenePlan();
    plan.actors.push({
      ...structuredClone(plan.actors[0]),
      key: "missing",
      actorId: "missing",
    });
    let draft: AssemblyDraft | undefined;
    try {
      await expect(
        assembleScene(plan, {
          ...f.context,
          checkpoint: async (value) => {
            draft = structuredClone(value);
          },
        }),
      ).rejects.toBeInstanceOf(AssemblyNeedsRepair);
      expect(draft!.roles.duck.actions.patrol.state).toBe("ready");
      expect(draft!.roles.missing.issues.length).toBeGreaterThan(0);
      let saves = 0;
      await expect(
        assembleScene(scenePlan(), {
          ...f.context,
          checkpoint: async () => {
            saves++;
            throw new Error("disk full");
          },
        }),
      ).rejects.toThrow("空间草稿保存失败");
      expect(saves).toBe(1);
    } finally {
      f.dispose();
    }
  });
  it("rechecks an edited route while retaining unchanged compiled action resources", async () => {
    const f = await assemblyFixture();
    let draft: AssemblyDraft | undefined;
    try {
      await assembleScene(scenePlan(), {
        ...f.context,
        checkpoint: async (value) => {
          draft = structuredClone(value);
        },
      });
      const oldCheck = draft!.roles.duck.checks.show.signature;
      const ids = Object.values(draft!.roles.duck.actions).map(
        (a) => a.action!.id,
      );
      draft!.roles.duck.locations.show.points[0].ground![0] += 0.1;
      delete draft!.roles.duck.locations.show.points[0].surface;
      draft!.roles.duck.locations.show.manual = true;
      await assembleScene(scenePlan(), { ...f.context, draft });
      expect(draft!.roles.duck.checks.show.signature).not.toBe(oldCheck);
      expect(
        Object.values(draft!.roles.duck.actions).map((a) => a.action!.id),
      ).toEqual(ids);
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
