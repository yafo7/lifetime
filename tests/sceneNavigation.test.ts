import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { normalizeMap } from "../src/client/rendering/map/shared/map";
import { buildSceneGeometry } from "../src/client/navigation/geometry";
import { Navigation } from "../src/client/navigation/navigation";
import { MotionRuntime } from "../src/client/motion/runtime";
import {
  mapSpace,
  validateSceneMotion,
  sceneContext,
} from "../src/shared/sceneMotion";
import { validatePoints } from "../src/shared/motion";
import { pointAtHeight } from "../src/client/rendering/surfacePicker";
import { AnimationPlayer } from "../src/client/rendering/animationPlayer";
import { buildModelGroupWithNodes } from "../src/client/rendering/map/client/modelRenderer";
import { revision, clip } from "./fixtures";
import type { Actor, ActorInstance } from "../src/shared/contracts";

const profile = { radius: 0.3, height: 1.5, climb: 0.3, slope: 35 };
const actor: Actor = {
  id: "actor",
  name: "fixture",
  updatedAt: 1,
  modelRevisions: [revision],
  animations: [clip],
};
describe("scene navigation and execution", () => {
  it("keeps the top of a rotated box ramp outside its coarse collision AABB", async () => {
    const angle = Math.PI / 12;
    const map = normalizeMap({
      box: { size: [20, 10, 20] },
      assets: [
        {
          id: "ramp-asset",
          name: "ramp",
          modelJson: {
            format: 2,
            nodes: [
              {
                id: "ramp",
                mesh: {
                  type: "box",
                  params: { width: 8, height: 0.2, depth: 4 },
                },
              },
            ],
          },
        },
      ],
      objects: [
        {
          id: "ramp",
          name: "ramp",
          assetId: "ramp-asset",
          visible: true,
          transform: {
            position: [0, 1.2, 0],
            rotation: [0, 0, angle],
            scale: [1, 1, 1],
            size: [1, 1, 1],
          },
        },
      ],
    } as any);
    const geometry = await buildSceneGeometry(map),
      nav = new Navigation(profile);
    try {
      await nav.build(geometry);
      const low = [
        -3,
        1.2 - 3 * Math.tan(angle) + 0.1 / Math.cos(angle),
        0,
      ] as [number, number, number];
      const high = [
        3,
        1.2 + 3 * Math.tan(angle) + 0.1 / Math.cos(angle),
        0,
      ] as [number, number, number];
      const path = nav.route(low, high);
      expect(path.at(-1)![1]).toBeGreaterThan(2);
      expect(path.every((p) => p[1] > 0.35)).toBe(true);
    } finally {
      nav.dispose();
      geometry.dispose();
    }
  });
  it("follows detail heights over a hill instead of taking a flat shortcut", async () => {
    const map = normalizeMap({
        box: { size: [20, 10, 20] },
        terrain: {
          resolutionX: 5,
          resolutionZ: 2,
          heights: [0, 0, 2, 0, 0, 0, 0, 2, 0, 0],
        },
      } as any),
      geometry = await buildSceneGeometry(map),
      nav = new Navigation(profile);
    try {
      await nav.build(geometry);
      const path = nav.route([-8, 0, 0], [8, 0, 0]);
      expect(Math.max(...path.map((p) => p[1]))).toBeGreaterThan(1.8);
      expect(path.at(-1)![0]).toBeCloseTo(8);
    } finally {
      nav.dispose();
      geometry.dispose();
    }
  });
  it("rejects a disconnected destination even when both ends have valid standing surfaces", async () => {
    const map = normalizeMap({
        box: { size: [20, 10, 20] },
        waterBodies: [
          {
            id: "river",
            name: "river",
            type: "lake",
            level: 0.2,
            depth: 1,
            points: [
              [-2, -10],
              [2, -10],
              [2, 10],
              [-2, 10],
            ],
            width: 1,
          },
        ],
      } as any),
      geometry = await buildSceneGeometry(map),
      nav = new Navigation(profile);
    try {
      await nav.build(geometry);
      expect(nav.project([-5, 0, 0])[0]).toBeCloseTo(-5);
      expect(nav.project([5, 0, 0])[0]).toBeCloseTo(5);
      expect(() => nav.route([-5, 0, 0], [5, 0, 0])).toThrow("不可达");
    } finally {
      nav.dispose();
      geometry.dispose();
    }
  });
  it("routes around a solid obstacle and rejects separated targets instead of partial success", async () => {
    const map = normalizeMap({
      box: { size: [20, 10, 20] },
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
            scale: [2, 3, 7],
            size: [1, 1, 1],
          },
        },
      ],
    } as any);
    const geometry = await buildSceneGeometry(map),
      nav = new Navigation(profile);
    try {
      await nav.build(geometry);
      const path = nav.route([-4, 0, 0], [4, 0, 0]);
      expect(path.some((p) => Math.abs(p[2]) > 3.5)).toBe(true);
      expect(path.at(-1)![0]).toBeCloseTo(4, 1);
      expect(() => nav.project([0, 0, 0])).toThrow();
      expect(() => nav.project([40, 0, 0])).toThrow();
    } finally {
      nav.dispose();
      geometry.dispose();
    }
  });
  it("does not turn submerged ground into walkable water but preserves elevated support", async () => {
    const map = normalizeMap({
      box: { size: [20, 10, 20] },
      waterBodies: [
        {
          id: "pond",
          name: "pond",
          type: "lake",
          level: 0.2,
          depth: 1,
          points: [
            [-2, -8],
            [2, -8],
            [2, 8],
            [-2, 8],
          ],
          width: 1,
        },
      ],
      objects: [
        {
          id: "bridge",
          name: "bridge",
          parentId: null,
          assetId: null,
          visible: true,
          locked: false,
          transform: {
            position: [0, 0.1, 0],
            rotation: [0, 0, 0],
            scale: [8, 0.15, 2],
            size: [1, 1, 1],
          },
        },
      ],
    } as any);
    const geometry = await buildSceneGeometry(map),
      nav = new Navigation({ ...profile, climb: 0.4 });
    try {
      await nav.build(geometry);
      expect(() => nav.project([0, 0.2, 5])).toThrow();
      const path = nav.route([-5, 0, 0], [5, 0, 0]);
      expect(path.some((p) => Math.abs(p[0]) < 1 && p[1] > 0.2)).toBe(true);
    } finally {
      nav.dispose();
      geometry.dispose();
    }
  });
  it("negative and elevated ground works in map space without weakening preview bounds", () => {
    const map = normalizeMap({ box: { size: [120, 20, 120] } } as any),
      instance: ActorInstance = {
        id: "one",
        actorId: actor.id,
        modelRevisionId: revision.id,
        clipId: null,
        position: [-55, -1, 0],
        rotation: 0,
        scale: 1,
        loop: false,
      };
    const plan = {
      schemaVersion: 2 as const,
      name: "move",
      modelRevisionId: revision.id,
      steps: [
        {
          id: "move",
          type: "moveTo" as const,
          destination: [55, 2, 0] as [number, number, number],
          speed: 10,
          animation: { clipId: clip.id, repeat: "untilArrival" as const },
        },
      ],
    };
    const runtime = new MotionRuntime({ route: (from, to) => [from, to] });
    runtime.executeAction(
      plan,
      sceneContext(actor, instance, map),
      instance.id,
      {},
      instance.position,
    );
    runtime.advance(100);
    expect(runtime.getExecutionState()?.position).toEqual([55, 2, 0]);
    expect(() =>
      new MotionRuntime().validateAction(plan, {
        actor,
        modelRevisionId: revision.id,
      }),
    ).toThrow();
    const p = {
      id: "p1",
      name: "p1",
      ground: [-55, -1, 0] as [number, number, number],
      height: 0,
    };
    expect(() => validatePoints([p], mapSpace(map))).not.toThrow();
    expect(() => validatePoints([p])).toThrow();
    expect(() =>
      validatePoints([pointAtHeight(p, -2, null, [-20, 100])], mapSpace(map)),
    ).not.toThrow();
  });
  it("finite route snapshots, rate independence, pause and separate instances share the same compiler", () => {
    const map = normalizeMap({ box: { size: [20, 10, 20] } } as any),
      ctx = { actor, modelRevisionId: revision.id, space: mapSpace(map) };
    const plan = {
      schemaVersion: 2 as const,
      name: "move and perform",
      modelRevisionId: revision.id,
      steps: [
        {
          id: "move",
          type: "moveTo" as const,
          destination: [4, 0, 0] as [number, number, number],
          speed: 2,
          animation: {
            clipId: clip.id,
            rate: 2,
            repeat: "untilArrival" as const,
          },
        },
        {
          id: "pose",
          type: "playClip" as const,
          animation: { clipId: clip.id, rate: 2, repeat: 1 },
        },
      ],
    };
    const create = () =>
      new MotionRuntime({
        route: (a, b) => [a, [0, 0, 2], [4, 0, 2], b],
        preserveRoot: true,
      });
    const a = create(),
      b = create();
    const timings = a.inspectAction(plan, ctx);
    expect(timings[0].duration).toBe(4);
    expect(timings[1].duration).toBe(1);
    const id = a.executeAction(plan, ctx, "a");
    b.executeAction(plan, ctx, "b");
    a.advance(1);
    a.pauseExecution(id);
    a.advance(1);
    b.advance(2);
    expect(a.getExecutionState()?.elapsed).toBe(1);
    expect(b.getExecutionState()?.elapsed).toBe(2);
    a.resumeExecution(id);
    a.advance(10);
    expect(a.getExecutionState()?.position).toEqual([4, 0, 0]);
    expect(a.frame?.preserveRoot).toBe(true);
  });
  it("preserves authored stationary root translation and a full revolution", async () => {
    const built = await buildModelGroupWithNodes(revision.modelJson, {
        fidelity: true,
      }),
      player = new AnimationPlayer(built),
      custom = {
        ...clip,
        animation: {
          fps: 1,
          duration: 2,
          loop: false,
          animation: {
            body: {
              posY: [0, 1, 0],
              posZ: [0, -0.8, 0],
              rotX: [0, Math.PI, Math.PI * 2],
            },
          },
        },
      };
    const rest = player.pose(null, 0),
      pose = player.pose(custom, 1);
    expect(pose.get("body")!.p.y - rest.get("body")!.p.y).toBe(1);
    expect(pose.get("body")!.p.z - rest.get("body")!.p.z).toBeCloseTo(-0.8);
    player.apply(player.pose(custom, 2));
    expect(
      built.objects.get("body")!.quaternion.angleTo(rest.get("body")!.q),
    ).toBeCloseTo(0);
    built.group.traverse((n) => {
      const m = n as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) =>
          x.dispose(),
        );
      }
    });
  });
  it("scene configuration rejects broken points, animations and navigation settings", () => {
    const map = normalizeMap({ box: { size: [20, 10, 20] } } as any),
      instance: ActorInstance = {
        id: "one",
        actorId: actor.id,
        modelRevisionId: revision.id,
        clipId: null,
        position: [0, 0, 0],
        rotation: 0,
        scale: 1,
        loop: false,
      };
    const c = {
      schemaVersion: 1 as const,
      navigation: profile,
      points: [
        {
          id: "p1",
          name: "p1",
          ground: [0, 0, 0] as [number, number, number],
          height: 0,
        },
      ],
      startPointId: "p1",
      selectedActionId: "action",
      actions: [
        {
          id: "action",
          name: "pose",
          plan: {
            schemaVersion: 2 as const,
            name: "pose",
            modelRevisionId: revision.id,
            steps: [
              {
                id: "pose",
                type: "playClip" as const,
                animation: { clipId: clip.id, repeat: 1 },
              },
            ],
          },
        },
      ],
    };
    validateSceneMotion(c, actor, instance, map);
    expect(() =>
      validateSceneMotion(
        { ...c, startPointId: "missing" },
        actor,
        instance,
        map,
      ),
    ).toThrow();
    expect(() =>
      validateSceneMotion(
        { ...c, navigation: { ...profile, radius: 0 } },
        actor,
        instance,
        map,
      ),
    ).toThrow();
    expect(() =>
      validateSceneMotion(
        {
          ...c,
          actions: [
            {
              ...c.actions[0],
              plan: { ...c.actions[0].plan, modelRevisionId: "missing" },
            },
          ],
        },
        actor,
        instance,
        map,
      ),
    ).toThrow();
  });
});
