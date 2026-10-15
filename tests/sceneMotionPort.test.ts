import { describe, it, expect } from "vitest";
import type { Actor, ActorInstance } from "../src/shared/contracts";
import type { MapResource } from "../src/shared/maps";
import type { Viewport } from "../src/client/rendering/viewport";
import { SceneMotionPort } from "../src/client/services/sceneMotionPort";
import { normalizeMap } from "../src/client/rendering/map/shared/map";
import { revision, clip, testMap } from "./fixtures";
import type { SceneAction } from "../src/shared/sceneMotion";
import { createActionTemplate } from "../src/shared/actionTemplates";
import { actionInputs } from "../src/shared/actionBinding";

async function ready(port: SceneMotionPort, id: string) {
  for (
    let i = 0;
    i < 100 && port.getMachineState(id)?.status === "starting";
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
}
function addMachine(i: ActorInstance) {
  const c = i.sceneMotion!;
  c.actions.push({
    id: "back",
    name: "return",
    plan: {
      ...structuredClone((c.actions[0] as SceneAction).plan),
      name: "return",
      steps: [
        {
          id: "back",
          type: "moveTo",
          speed: 2,
          destination: [-5, 0, i.position[2]],
          path: { mode: "ground" },
          animation: { clipId: clip.id, repeat: "untilArrival" },
        },
      ],
    },
  });
  c.machine = {
    schemaVersion: 1,
    enabled: true,
    initialStateId: "out",
    states: [
      {
        id: "out",
        name: "go",
        actionId: "action",
        repetitions: 1,
        waitSeconds: 0.5,
        nextStateId: "home",
      },
      {
        id: "home",
        name: "back",
        actionId: "back",
        repetitions: 1,
        waitSeconds: 0,
        nextStateId: "out",
      },
    ],
  };
}

const actor: Actor = {
  id: "actor",
  name: "fixture",
  updatedAt: 1,
  modelRevisions: [revision],
  animations: [clip],
};
function instance(id: string): ActorInstance {
  return {
    id,
    actorId: actor.id,
    modelRevisionId: revision.id,
    clipId: null,
    position: [-5, 0, id === "two" ? 3 : 0],
    rotation: 0,
    scale: 1,
    loop: false,
    sceneMotion: {
      schemaVersion: 1,
      points: [
        {
          id: "p1",
          name: "p1",
          ground: [5, 0, id === "two" ? 3 : 0],
          height: 0,
        },
      ],
      navigation: { radius: 0.3, height: 3, climb: 0.3, slope: 35 },
      startPointId: null,
      selectedActionId: "action",
      actions: [
        {
          id: "action",
          name: "move",
          plan: {
            schemaVersion: 2,
            name: "move",
            modelRevisionId: revision.id,
            steps: [
              {
                id: "move",
                type: "moveTo",
                speed: 2,
                destination: { point: "p1" },
                path: { mode: "ground" },
                animation: { clipId: clip.id, repeat: "untilArrival" },
              },
            ],
          },
        },
      ],
    },
  };
}
function setup(map = testMap, actors = actor) {
  const frames = new Map<string, unknown>(),
    resets: string[] = [];
  const view = {
    onSceneFrame: () => {},
    getFoundations: () => new Map(),
    setSceneGeometry: () => {},
    resolveMotionContext: (ctx: unknown) => ctx,
    showSceneGuide: () => {},
    clearSceneGuide: () => {},
    applySceneFrame: (id: string, frame: unknown) => frames.set(id, frame),
    seekSceneFrame: (id: string, frame: unknown) => frames.set(id, frame),
    resetSceneInstance: (i: ActorInstance) => resets.push(i.id),
  } as unknown as Viewport;
  const port = new SceneMotionPort(view),
    instances = [instance("one"), instance("two")],
    resource: MapResource = {
      id: "map",
      name: map.name,
      map,
      scheme: null,
      updatedAt: 1,
    };
  port.bind(resource, new Map([[actors.id, actors]]), instances);
  return { port, instances, frames, resets, view };
}
describe("scene motion port", () => {
  it("blocks at occupied paths without consuming action time, then resumes; seeks cannot overlap another NPC", async () => {
    const { port, instances, view } = setup();
    instances[1].position = [0, 0, 0];
    try {
      await port.executeAction("one");
      view.onSceneFrame(20);
      const blocked = port.getExecutionState("one")!;
      expect(blocked.status).toBe("running");
      expect(blocked.blocked).toBe(true);
      expect(blocked.position[0]).toBeLessThanOrEqual(-0.72);
      expect(blocked.elapsed).toBeLessThan(5);
      view.onSceneFrame(1);
      expect(port.getExecutionState("one")!.elapsed).toBe(blocked.elapsed);
      expect(() => port.seekExecution("one", 2.5)).toThrow("重叠");
      expect(port.getExecutionState("one")!.elapsed).toBe(blocked.elapsed);
      port.updateConfiguration("two", (i) => {
        i.position = [0, 0, 4];
      });
      view.onSceneFrame(5);
      expect(port.getExecutionState("one")!.status).toBe("completed");
      expect(port.getExecutionState("one")!.position[0]).toBeCloseTo(5);
      expect(instances[0].position).toEqual([-5, 0, 0]);
    } finally {
      port.dispose();
    }
  });
  it("rejects an overlapping start before applying a live pose and includes the temporary player in NPC collisions", async () => {
    const { port, instances, view, frames } = setup();
    instances[1].position = [-5, 0, 0];
    try {
      await expect(port.executeAction("one")).rejects.toThrow("重叠");
      expect(frames.size).toBe(0);
      instances[1].position = [-5, 0, 3];
      Object.defineProperty(view, "playerCollisionBody", {
        configurable: true,
        value: {
          id: "player:test",
          position: [0, 0, 0],
          radius: 0.3,
          height: 2,
        },
      });
      await port.executeAction("one");
      view.onSceneFrame(8);
      expect(port.getExecutionState("one")!.blocked).toBe(true);
      expect(port.getExecutionState("one")!.position[0]).toBeLessThanOrEqual(
        -0.72,
      );
      expect(
        view.onPlayerMove([0, 0, 3], [-5, 0, 3], {
          radius: 0.3,
          height: 2,
          climb: 0.3,
          slope: 35,
        }),
      ).toBe(false);
    } finally {
      port.dispose();
    }
  });
  it("previews jump links without generation, then generates once on playback and lands at the map target", async () => {
    const map = structuredClone(testMap);
    map.objects.push({
      id: "platform",
      name: "platform",
      assetId: null,
      visible: true,
      transform: {
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [4, 1.5, 4],
        size: [1, 1, 1],
      },
    } as any);
    const { port, view } = setup(map);
    const npc = instance("one");
    npc.sceneMotion!.points[0].ground = [0, 1.5, 0];
    port.bind(
      { id: "map", name: "map", map, scheme: null, updatedAt: 1 },
      new Map([[actor.id, actor]]),
      [npc],
    );
    let generations = 0;
    port.onTraversalAssets = async (_id, kinds) => {
      generations++;
      expect(kinds).toEqual(["jump"]);
      return {
        ...actor,
        animations: [
          ...actor.animations,
          { ...clip, id: "jump", name: "导航跳跃" },
        ],
      };
    };
    try {
      const preview = await port.prepareAction("one");
      expect(preview.missingTraversal).toEqual(["jump"]);
      expect(generations).toBe(0);
      expect(() => port.startPrepared(preview)).toThrow("尚未准备好");
      await port.executeAction("one");
      expect(generations).toBe(1);
      view.onSceneFrame(100);
      expect(
        Math.abs(port.getExecutionState("one")!.position[1] - 1.5),
      ).toBeLessThan(0.1);
      await port.executeAction("one");
      expect(generations).toBe(1);
    } finally {
      port.dispose();
    }
  });
  it("calculates the navigation route against edited draft points without changing playback or persisted configuration", async () => {
    const { port } = setup();
    try {
      await port.executeAction("one");
      port.pauseExecution("one");
      const before = port.getConfiguration("one"),
        state = port.getExecutionState("one");
      const points = structuredClone(before.sceneMotion!.points);
      points[0].ground = [2, 0, 4];
      const paths = await port.inspectRoute("one", "action", points);
      expect(paths).toHaveLength(1);
      expect(paths[0].at(-1)![0]).toBeCloseTo(2, 1);
      expect(paths[0].at(-1)![2]).toBeCloseTo(4, 1);
      expect(port.getConfiguration("one")).toEqual(before);
      expect(port.getExecutionState("one")).toEqual(state);
      points[0].ground = [10000, 0, 0];
      await expect(
        port.inspectRoute("one", "action", points),
      ).rejects.toThrow();
      expect(port.getExecutionState("one")).toEqual(state);
    } finally {
      port.dispose();
    }
  });
  it("pins actor actions, blocks stale resume, and explicitly refreshes a reference without copying steps", async () => {
    const draft = createActionTemplate(
      actor,
      revision.id,
      "stationary",
      clip.id,
      [clip.id],
    );
    const source = {
      ...draft,
      id: "source",
      name: draft.plan.name,
      prompt: "fixture",
      modelRevisionId: revision.id,
      createdAt: 1,
      updatedAt: 1,
    };
    const sourceActor = { ...actor, motionActions: [source] };
    const { port } = setup(testMap, sourceActor);
    try {
      port.updateConfiguration("one", (i) => {
        i.sceneMotion!.schemaVersion = 2;
        i.sceneMotion!.actions = [];
        i.sceneMotion!.selectedActionId = null;
      });
      const id = port.bindAction("one", source.id);
      await port.executeAction("one", id);
      port.pauseExecution("one");
      source.updatedAt = 2;
      expect(() => port.resumeExecution("one")).toThrow("已更新");
      expect(port.getExecutionState("one")).toBeNull();
      await expect(port.executeAction("one", id)).rejects.toThrow(
        "演员动作已修改",
      );
      port.updateActionBinding("one", id, {}, true);
      const bound = port.getConfiguration("one").sceneMotion!.actions[0];
      expect(bound).toMatchObject({
        actorActionId: source.id,
        actorActionUpdatedAt: 2,
      });
      expect(bound).not.toHaveProperty("plan");
      await port.executeAction("one", id);
      expect(port.getExecutionState("one")?.status).toBe("running");
      port.updateActor(structuredClone(sourceActor));
      expect(port.getExecutionState("one")).toBeNull();
    } finally {
      port.dispose();
    }
  });
  it("switches two behavior states, each referencing a complete actor action with map bindings", async () => {
    const route = createActionTemplate(
        actor,
        revision.id,
        "route",
        clip.id,
        [],
      ),
      visit = createActionTemplate(actor, revision.id, "visit", clip.id, [
        clip.id,
      ]);
    const sources = [route, visit].map((draft, index) => ({
      ...draft,
      id: "source" + index,
      name: draft.plan.name,
      prompt: "fixture",
      modelRevisionId: revision.id,
      createdAt: 1,
      updatedAt: 1,
    }));
    const sourceActor = { ...actor, motionActions: sources },
      { port, instances, view } = setup(testMap, sourceActor);
    instances[1].position = [8, 0, 8]; // This test exercises one machine, away from idle NPCs.
    for (const i of instances) {
      const c = i.sceneMotion!;
      c.schemaVersion = 2;
      c.points = [
        [-5, 0, -5],
        [5, 0, -5],
        [5, 0, 5],
        [-5, 0, 5],
        [0, 0, 0],
        [0, 0, 3],
      ].map((ground, index) => ({
        id: "p" + index,
        name: "p" + (index + 1),
        ground: ground as [number, number, number],
        height: 0,
      }));
      c.actions = sources.map((source, index) => ({
        id: "bound" + index,
        name: source.name,
        actorActionId: source.id,
        actorActionUpdatedAt: source.updatedAt,
        bindings: Object.fromEntries(
          actionInputs(source).map((slot, j) => [
            slot.id,
            index === 0 ? "p" + j : ["p4", "p5", "p0"][j],
          ]),
        ),
      }));
      c.selectedActionId = "bound0";
      c.startPointId = "p0";
      c.machine = {
        schemaVersion: 1,
        enabled: true,
        initialStateId: "patrol",
        states: [
          {
            id: "patrol",
            name: "巡游",
            actionId: "bound0",
            repetitions: 1,
            waitSeconds: 0,
            nextStateId: "perform",
          },
          {
            id: "perform",
            name: "表演并返回",
            actionId: "bound1",
            repetitions: 1,
            waitSeconds: 0,
            nextStateId: "patrol",
          },
        ],
      };
    }
    try {
      await port.startStateMachine("one");
      view.onSceneFrame(100);
      await ready(port, "one");
      expect(port.getMachineState("one")?.stateId).toBe("perform");
      expect(port.getExecutionState("one")?.position[0]).toBeCloseTo(-5);
      view.onSceneFrame(100);
      await ready(port, "one");
      expect(port.getMachineState("one")?.stateId).toBe("patrol");
      expect(
        instances[0].sceneMotion!.actions.every((a) => !("plan" in a)),
      ).toBe(true);
      expect(sourceActor.motionActions).toEqual(sources);
    } finally {
      port.dispose();
    }
  });
  it("runs two state machines independently, continues from endpoints and preserves design transforms", async () => {
    const { port, instances, view } = setup();
    instances.forEach(addMachine);
    try {
      await port.playAll();
      port.pauseExecution("two");
      view.onSceneFrame(5);
      expect(port.getMachineState("one")?.status).toBe("waiting");
      expect(port.getExecutionState("one")?.position[0]).toBeCloseTo(5);
      expect(port.getExecutionState("two")?.elapsed).toBe(0);
      view.onSceneFrame(0.5);
      await ready(port, "one");
      expect(port.getMachineState("one")?.stateId).toBe("home");
      expect(port.getExecutionState("one")?.position[0]).toBeCloseTo(5);
      view.onSceneFrame(1);
      expect(port.getExecutionState("one")?.position[0]).toBeCloseTo(3);
      expect(instances[0].position).toEqual([-5, 0, 0]);
      await port.switchState("one", "out");
      expect(port.getExecutionState("one")?.position[0]).toBeCloseTo(3);
      port.pauseAll();
      view.onSceneFrame(5);
      expect(port.getMachineState("one")?.status).toBe("paused");
      await port.playAll();
      expect(port.getMachineState("two")?.status).toBe("running");
      port.cancelAll();
      expect(port.getMachineState("one")).toBeNull();
    } finally {
      port.dispose();
    }
  });
  it("invalidates pending state preparations on edits and prevents an actor from starting after unbind", async () => {
    const { port, instances, frames } = setup();
    instances.forEach(addMachine);
    try {
      const pending = port.startStateMachine("one");
      port.updateConfiguration("one", (i) => {
        i.sceneMotion!.points[0].ground = [4, 0, 0];
      });
      await pending;
      expect(port.getMachineState("one")).toBeNull();
      expect(port.getExecutionState("one")).toBeNull();
      expect(frames.size).toBe(0);
      const second = port.startStateMachine("two");
      port.unbind();
      await second;
      expect(port.getExecutionState("two")).toBeNull();
      expect(frames.size).toBe(0);
    } finally {
      port.dispose();
    }
  });
  it("executes independent instances, emits started, freezes pause and restores design pose", async () => {
    const { port, frames, resets, view } = setup(),
      source = structuredClone(actor);
    const events: string[] = [];
    port.subscribe((e) => events.push(e.type));
    try {
      await port.executeAction("one");
      await port.executeAction("two");
      view.onSceneFrame(1);
      port.pauseExecution("one");
      view.onSceneFrame(1);
      expect(port.getExecutionState("one")?.elapsed).toBeCloseTo(1);
      expect(port.getExecutionState("two")?.elapsed).toBeCloseTo(2);
      port.seekExecution("one", 3);
      expect(port.getExecutionState("one")).toMatchObject({
        elapsed: 3,
        status: "paused",
      });
      expect(port.getExecutionState("two")?.elapsed).toBeCloseTo(2);
      port.resumeExecution("one");
      view.onSceneFrame(100);
      expect(port.getExecutionState("one")?.position[0]).toBeCloseTo(5);
      expect(events.filter((e) => e === "started")).toHaveLength(2);
      expect(frames.size).toBe(2);
      port.cancelExecution("one");
      expect(port.getExecutionState("one")).toBeNull();
      expect(resets).toContain("one");
      expect(actor).toEqual(source);
    } finally {
      port.dispose();
    }
  });
  it("rejects stale preparations and invalid edits before changing live configuration", async () => {
    const { port, frames } = setup();
    try {
      const pending = port.prepareAction("one");
      port.updateConfiguration("one", (i) => {
        i.sceneMotion!.points[0].ground = [4, 0, 0];
      });
      await expect(pending).rejects.toThrow("配置已更改");
      expect(frames.size).toBe(0);
      const before = port.getConfiguration("one");
      const invalid = structuredClone(before.sceneMotion!);
      (invalid.actions[0] as SceneAction).plan.steps[0] = {
        id: "bad",
        type: "playClip",
        animation: { clipId: "missing" },
      };
      expect(() => port.setConfiguration("one", invalid)).toThrow();
      expect(port.getConfiguration("one")).toEqual(before);
    } finally {
      port.dispose();
    }
  });
  it("keeps unplaced imported point drafts editable, but blocks execution until placement", async () => {
    const { port } = setup();
    try {
      const value = port.getConfiguration("one").sceneMotion!;
      value.points[0].ground = null;
      port.setConfiguration("one", value);
      await expect(port.prepareAction("one")).rejects.toMatchObject({
        code: "POINT_UNPLACED",
      });
      expect(port.getExecutionState("one")).toBeNull();
    } finally {
      port.dispose();
    }
  });
  it("rejects authored stationary root motion through a wall before starting any actor", async () => {
    const map = normalizeMap({
      ...testMap,
      objects: [
        {
          id: "wall",
          name: "wall",
          parentId: null,
          assetId: null,
          visible: true,
          locked: false,
          transform: {
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [2, 4, 4],
            size: [1, 1, 1],
          },
        },
      ],
    } as any);
    const moving = {
        ...actor,
        animations: [
          {
            ...clip,
            animation: {
              fps: 1,
              duration: 2,
              loop: false,
              animation: { body: { posX: [0, 5, 0] } },
            },
          },
        ],
      },
      { port, frames } = setup(map, moving);
    try {
      port.updateConfiguration("one", (i) => {
        (i.sceneMotion!.actions[0] as SceneAction).plan.steps = [
          {
            id: "pose",
            type: "playClip",
            animation: { clipId: clip.id, repeat: 1 },
          },
        ];
      });
      await expect(port.executeAction("one")).rejects.toThrow("更多空间");
      expect(port.getExecutionState("one")).toBeNull();
      expect(frames.size).toBe(0);
    } finally {
      port.dispose();
    }
  });
});
