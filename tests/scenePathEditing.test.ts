import { describe, it, expect } from "vitest";
import type { Actor, ActorInstance } from "../src/shared/contracts";
import type { SavedAction } from "../src/shared/motion";
import {
  resolveBoundAction,
  type BoundAction,
} from "../src/shared/actionBinding";
import { removeScenePathPoint } from "../src/shared/scenePathEditing";
import {
  sceneActionPlan,
  validateSceneMotion,
  type SceneMotion,
} from "../src/shared/sceneMotion";
import { revision, clip, testMap } from "./fixtures";

function fixture() {
  const source: SavedAction = {
    id: "source",
    name: "route",
    prompt: "",
    createdAt: 1,
    updatedAt: 1,
    modelRevisionId: revision.id,
    plan: {
      schemaVersion: 2,
      name: "route",
      modelRevisionId: revision.id,
      steps: [
        {
          id: "move",
          type: "moveTo",
          speed: 2,
          destination: { point: "finish" },
          path: { mode: "ground", via: [{ point: "via" }, { point: "other" }] },
          animation: { clipId: clip.id, repeat: "untilArrival" },
        },
      ],
    },
  };
  const actor: Actor = {
    id: "actor",
    name: "actor",
    updatedAt: 1,
    modelRevisions: [revision],
    animations: [clip],
    motionActions: [source],
  };
  const binding: BoundAction = {
    id: "action",
    name: "route",
    actorActionId: source.id,
    actorActionUpdatedAt: 1,
    bindings: { "point:via": "p1", "point:other": "p2", "point:finish": "p3" },
  };
  const config: SceneMotion = {
    schemaVersion: 2,
    points: ["p0", "p1", "p2", "p3"].map((id, n) => ({
      id,
      name: "p" + (n + 1),
      ground: [n, 0, n],
      height: 0,
    })),
    actions: [binding],
    startPointId: "p0",
    selectedActionId: "action",
    navigation: { radius: 0.3, height: 2, climb: 0.3, slope: 35 },
  };
  const instance: ActorInstance = {
    id: "npc",
    actorId: actor.id,
    modelRevisionId: revision.id,
    position: [0, 0, 0],
    rotation: 0,
    scale: 1,
    clipId: null,
    loop: false,
    sceneMotion: config,
  };
  return { actor, source, binding, config, instance };
}

describe("map path point deletion", () => {
  it("removes intermediate stops represented by consecutive moveTo steps without deleting a performance stop", () => {
    const { actor, source, binding, config } = fixture();
    const move = source.plan.steps[0];
    if (move.type !== "moveTo") throw new Error("fixture");
    source.plan.steps = [
      {
        ...structuredClone(move),
        id: "first",
        destination: { point: "via" },
        path: { mode: "ground" },
      },
      {
        ...structuredClone(move),
        id: "second",
        destination: { point: "other" },
        path: { mode: "ground" },
      },
      { ...structuredClone(move), id: "last", path: { mode: "ground" } },
    ];
    const edited = removeScenePathPoint(config, "p1", actor, revision.id);
    const plan = sceneActionPlan(edited.actions[0], {
      actor,
      modelRevisionId: revision.id,
      points: edited.points,
    });
    expect(plan.steps.map((s) => s.id)).toEqual(["second", "last"]);
    expect(source.plan.steps).toHaveLength(3);
    expect(binding.bindings["point:via"]).toBe("p1");
    source.plan.steps.splice(1, 0, {
      id: "perform",
      type: "playClip",
      animation: { clipId: clip.id, repeat: 1 },
    });
    expect(() =>
      removeScenePathPoint(config, "p1", actor, revision.id),
    ).toThrow("终点");
  });
  it("removes a waypoint from every shared action, round-trips and leaves the actor and original draft intact", () => {
    const { actor, source, binding, config, instance } = fixture();
    config.actions.push({ ...structuredClone(binding), id: "shared" });
    const before = structuredClone({ actor, config });
    const edited = JSON.parse(
      JSON.stringify(removeScenePathPoint(config, "p1", actor, revision.id)),
    ) as SceneMotion;
    expect(edited.points.map((p) => p.id)).toEqual(["p0", "p2", "p3"]);
    for (const action of edited.actions) {
      expect(action).toMatchObject({ excludedRouteInputs: ["point:via"] });
      expect(
        sceneActionPlan(action, {
          actor,
          modelRevisionId: revision.id,
          points: edited.points,
        }).steps[0],
      ).toMatchObject({
        path: { via: [{ point: "p2" }] },
        destination: { point: "p3" },
      });
    }
    expect(() =>
      validateSceneMotion(edited, actor, instance, testMap),
    ).not.toThrow();
    expect({ actor, config }).toEqual(before);
    expect(source.plan.steps[0]).toMatchObject({
      path: { via: [{ point: "via" }, { point: "other" }] },
    });
    const withoutVia = removeScenePathPoint(edited, "p2", actor, revision.id);
    expect(
      sceneActionPlan(withoutVia.actions[0], {
        actor,
        modelRevisionId: revision.id,
        points: withoutVia.points,
      }).steps[0],
    ).toMatchObject({ path: { via: [] } });
  });
  it("protects start, destinations, facing targets and shared required inputs without partial edits", () => {
    const { actor, source, config } = fixture();
    expect(() =>
      removeScenePathPoint(config, "p0", actor, revision.id),
    ).toThrow("起始站位");
    expect(() =>
      removeScenePathPoint(config, "p3", actor, revision.id),
    ).toThrow("终点");
    source.plan.steps.push({
      id: "face",
      type: "turnTo",
      target: { point: "via" },
      speed: 2,
    });
    const before = structuredClone(config);
    expect(() =>
      removeScenePathPoint(config, "p1", actor, revision.id),
    ).toThrow("朝向目标");
    expect(config).toEqual(before);
    const bad = {
      ...config.actions[0],
      excludedRouteInputs: ["point:finish"],
    } as BoundAction;
    expect(() =>
      resolveBoundAction(actor, bad, {
        actor,
        modelRevisionId: revision.id,
        points: config.points,
      }),
    ).toThrow("只能移除路径途经点");
  });
  it("keeps legacy embedded actions read-only and permits deleting an unused point", () => {
    const { actor, source, config } = fixture();
    config.schemaVersion = 1;
    const plan = structuredClone(source.plan);
    const step = plan.steps[0];
    if (step.type !== "moveTo") throw new Error("fixture");
    step.destination = { point: "p3" };
    step.path!.via = [{ point: "p1" }, { point: "p2" }];
    config.actions = [{ id: "action", name: "legacy", plan }];
    const before = structuredClone(config);
    expect(() =>
      removeScenePathPoint(config, "p1", actor, revision.id),
    ).toThrow("迁入演员库");
    expect(step.path!.via).toHaveLength(2);
    expect(config).toEqual(before);
    config.points.push({
      id: "unused",
      name: "p5",
      ground: [1, 0, 1],
      height: 0,
    });
    expect(
      removeScenePathPoint(config, "unused", actor, revision.id).points,
    ).toHaveLength(4);
  });
});
